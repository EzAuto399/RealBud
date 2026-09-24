import type { Invoice } from './billing.ts';
const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function aud(value:string):string { const n=BigInt(value),abs=n<0n?-n:n; return `${n<0n?'-':''}A$${abs/100n}.${String(abs%100n).padStart(2,'0')}`; }
/** The printable care invoice. Its lines are the care fee, care credits and
 * rounding only; AI usage is billed by Modelvia and never rendered here. */
export function invoiceHtml(invoice:Invoice):string {
  const collected=invoice.mode==='commercial' && !!invoice.commercialTerms;
  const abn=invoice.supplier.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/,'$1 $2 $3 $4');
  return `<!doctype html><html lang="en-AU"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(invoice.id)} — ${escape(invoice.kind)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;color:#152e31;max-width:880px;margin:40px auto;padding:0 24px}header{border-bottom:3px solid #267166;padding-bottom:24px}h1{font-size:32px;margin:8px 0}.label{color:#8a4524;font-weight:700}table{width:100%;border-collapse:collapse;margin:32px 0}th,td{text-align:left;border-bottom:1px solid #ddd;padding:12px 8px;vertical-align:top}th:last-child,td:last-child{text-align:right;white-space:nowrap}small{display:block;font-size:12px;overflow-wrap:anywhere}.total{text-align:right;font-size:22px;font-weight:650}@media print{body{margin:0;max-width:none}tr{break-inside:avoid}}</style>
<header>${collected?'':`<div class="label">LOCAL TEST DOCUMENT — no payment requested</div>`}<h1>${escape(invoice.kind)}</h1><b>${escape(invoice.supplier.legalName)}</b> · ABN ${escape(abn)}<br>${invoice.supplier.address?`${escape(invoice.supplier.address)}<br>`:''}RealBud · GST registered</header>
<p><b>${escape(invoice.id)}</b><br>Issued ${escape(new Date(invoice.issuedAt+36_000_000).toISOString().slice(0,10))} (Brisbane) · Billing month ${escape(invoice.period)}</p>
<p><b>Bill to ${escape(invoice.customer.name)}</b><br>${escape(invoice.customer.address)}${invoice.customer.abn?`<br>ABN ${escape(invoice.customer.abn)}`:''}</p>
<table><thead><tr><th>Item</th><th>GST inclusive amount</th></tr></thead><tbody>${invoice.lines.map(l=>`<tr><td>${escape(l.description)}${l.creditId?`<small>Credit reference ${escape(l.creditId)}</small>`:''}${l.sourceInvoice?`<small>Credit against ${escape(l.sourceInvoice)}</small>`:''}</td><td>${aud(l.amountCents)}</td></tr>`).join('')}</tbody></table>
<p class="total">Total ${aud(invoice.totalCents)}</p><p style="text-align:right">Includes GST ${aud(invoice.gstCents)}</p>
<p><small>Amounts are in AUD including GST. The care fee covers RealBud software and routine maintenance; credits and monthly rounding appear separately. AI usage is billed separately by Modelvia and never appears on this invoice. ${collected?`Accepted terms ${escape(invoice.commercialTerms!.version)} · ${escape(invoice.commercialTerms!.digest)}. Payment status and receipts are available in your RealBud account; this invoice alone is not a payment receipt.`:'This local document is for review and does not establish a payment.'}</small></p></html>`;
}
