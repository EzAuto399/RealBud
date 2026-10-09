import type { Invoice } from './billing.ts';
/** How an office pays by transfer, from gateway configuration
 * (`REALBUD_PAYID*`, `REALBUD_BANK_*`, composition.ts); each part null when not
 * configured. The template never reads the environment. */
export interface PaymentInstructions { payId:{id:string;name:string}|null; bank:{accountName:string;bsb:string;accountNumber:string}|null }
const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function aud(value:string):string { const n=BigInt(value),abs=n<0n?-n:n; return `${n<0n?'-':''}A$${abs/100n}.${String(abs%100n).padStart(2,'0')}`; }
const brisbaneDate=(at:number)=>new Date(at+36_000_000).toISOString().slice(0,10);
const abnText=(abn:string)=>abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/,'$1 $2 $3 $4');
/** Where the office downloads an invoice's per-request AI usage: the website's
 * billing route, which proxies GET /v1/portal/invoices/{id}/ai-usage. */
export const aiUsageCsvPath=(invoiceId:string)=>`/api/account/invoices/${encodeURIComponent(invoiceId)}/ai-usage`;
export const invoiceDocumentPath=(invoiceId:string)=>`/api/account/invoices/${encodeURIComponent(invoiceId)}?kind=document`;
/** The invoice JSON the office reads: the stored invoice unchanged, plus the
 * links to its document and, when it carries AI usage, the per-request CSV. */
export function presentInvoice(invoice:Invoice) {
  return {...invoice,links:{document:invoiceDocumentPath(invoice.id),...(invoice.aiUsage?.modelviaInvoices.length?{aiUsageCsv:aiUsageCsvPath(invoice.id)}:{})}};
}
/** The printable monthly invoice. It names the office (registered and trading
 * name, ABN, address, RealBud account id), the billing month, the invoice number
 * and its issue and due dates; then the care fee, care credits, rounding and, for
 * an office that accepted AI resale, each line of its Modelvia AI usage invoice
 * (per model, with its request count and who used it) at that line's exact
 * GST-inclusive amount and GST. All-in amounts only, unless the office's invoice
 * was closed itemized: then Modelvia's split is shown under each line. Never a
 * wholesale, platform-fee or markup figure. With payment instructions, a payable
 * invoice also says how to pay: PayID, bank transfer with the invoice number as
 * the reference, and card from the account when Square collection is on. */
export function invoiceHtml(invoice:Invoice,options:{paymentInstructions?:PaymentInstructions;card?:boolean}={}):string {
  const collected=invoice.mode==='commercial' && !!invoice.commercialTerms;
  const ai=invoice.lines.some(l=>l.modelviaInvoice), deferred=invoice.aiUsage?.deferredPeriods?.join(', ');
  const office=invoice.customer.tradingName??invoice.customer.name;
  const modelviaIds=invoice.aiUsage?.modelviaInvoices.map(i=>i.id)??[];
  const csv=ai?`<p class="usage"><a href="${escape(aiUsageCsvPath(invoice.id))}" download>Download the per-request AI usage (CSV)</a> — date and time, user or project, model, tokens in and out, and amount for every request on this invoice. It is also on the billing page of your RealBud account.</p>`:'';
  const aiNote=ai
    ?`AI usage lines are the exact lines, GST-inclusive amounts and GST of the named Modelvia invoice${modelviaIds.length===1?'':'s'}, and are paid with this invoice, not separately.${deferred?` AI usage for ${escape(deferred)} was not yet finalized and will appear on a later invoice.`:''}`
    :deferred?`AI usage for ${escape(deferred)} was not yet finalized and will appear on a later invoice.`
    :'No AI usage is charged on this invoice.';
  const usage=ai||deferred?`<section class="usage"><h2>Usage by ${escape(office)}</h2><p>${invoice.aiUsage?.usedBy?`Modelvia account name ${escape(invoice.aiUsage.usedBy)} · `:''}${invoice.aiUsage?.modelviaCustomerId?`Modelvia customer ID <b>${escape(invoice.aiUsage.modelviaCustomerId)}</b> · `:''}RealBud account ${escape(invoice.companyId)}${modelviaIds.length?` · Modelvia invoice${modelviaIds.length===1?'':'s'} ${modelviaIds.map(escape).join(', ')}`:''}</p></section>`:'';
  const line=(l:Invoice['lines'][number])=>{
    const notes=[
      l.modelviaInvoice?`Reference: Modelvia invoice ${escape(l.modelviaInvoice)} · GST ${aud(l.gstCents)}`:'',
      l.usedBy?`Used by ${escape(l.usedBy)}`:'',
      l.components?`Model usage ${aud(l.components.modelUsageCents)} · Routing ${aud(l.components.routingCents)} · Service fee ${aud(l.components.serviceFeeCents)}`:'',
      l.creditId?`Credit reference ${escape(l.creditId)}`:'', l.sourceInvoice?`Credit against ${escape(l.sourceInvoice)}`:'',
    ].filter(Boolean).map(n=>`<small>${n}</small>`).join('');
    return `<tr><td>${escape(l.description)}${notes}</td><td>${aud(l.amountCents)}</td></tr>`;
  };
  const dueDays=invoice.dueAt!==undefined?Math.round((invoice.dueAt-invoice.issuedAt)/86_400_000):0;
  const due=invoice.dueAt!==undefined?` · Due ${escape(brisbaneDate(invoice.dueAt))}${invoice.dueAt===invoice.issuedAt?' (on receipt)':` (due in ${dueDays} day${dueDays===1?'':'s'})`}`:'';
  const instructions=options.paymentInstructions;
  const payable=collected && invoice.kind==='Tax Invoice' && BigInt(invoice.totalCents)>0n;
  const ways=payable && instructions?[
    instructions.payId?`<li><b>PayID</b> ${escape(instructions.payId.id)} (${escape(instructions.payId.name)})</li>`:'',
    instructions.bank?`<li><b>Bank transfer</b> to ${escape(instructions.bank.accountName)} · BSB ${escape(instructions.bank.bsb)} · Account ${escape(instructions.bank.accountNumber)}</li>`:'',
  ].filter(Boolean):[];
  const howToPay=ways.length?`<section class="usage"><h2>How to pay</h2><ul>${ways.join('')}${options.card?'<li><b>Card</b> from the billing page of your RealBud account</li>':''}</ul><p>Use <b>${escape(invoice.id)}</b> as the payment reference so we can match your payment.</p></section>`:'';
  return `<!doctype html><html lang="en-AU"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(invoice.id)} — ${escape(invoice.kind)} — ${escape(office)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;color:#152e31;max-width:880px;margin:40px auto;padding:0 24px}header{border-bottom:3px solid #267166;padding-bottom:24px}h1{font-size:32px;margin:8px 0}h2{font-size:18px;margin:0 0 4px}.label{color:#8a4524;font-weight:700}.parties{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media (max-width:600px){.parties{grid-template-columns:1fr}}.usage{background:#f2f7f6;padding:12px 16px;border-radius:6px}table{width:100%;border-collapse:collapse;margin:32px 0}th,td{text-align:left;border-bottom:1px solid #ddd;padding:12px 8px;vertical-align:top}th:last-child,td:last-child{text-align:right;white-space:nowrap}small{display:block;font-size:12px;overflow-wrap:anywhere}.total{text-align:right;font-size:22px;font-weight:650}@media print{body{margin:0;max-width:none}tr{break-inside:avoid}}</style>
<header>${collected?'':`<div class="label">LOCAL TEST DOCUMENT — no payment requested</div>`}<h1>${escape(invoice.kind)}</h1><b>${escape(invoice.supplier.legalName)}</b> · ABN ${escape(abnText(invoice.supplier.abn))}<br>${invoice.supplier.address?`${escape(invoice.supplier.address)}<br>`:''}RealBud · GST registered</header>
<p><b>Invoice ${escape(invoice.id)}</b><br>Issued ${escape(brisbaneDate(invoice.issuedAt))} (Brisbane)${due} · Billing month ${escape(invoice.period)}</p>
<div class="parties"><p><b>Bill to ${escape(invoice.customer.name)}</b>${invoice.customer.tradingName?`<br>Trading as ${escape(invoice.customer.tradingName)}`:''}<br>${escape(invoice.customer.address)}${invoice.customer.abn?`<br>ABN ${escape(abnText(invoice.customer.abn))}`:''}<br>RealBud account ${escape(invoice.companyId)}</p></div>
${usage}
<table><thead><tr><th>Item</th><th>GST inclusive amount</th></tr></thead><tbody>${invoice.lines.map(line).join('')}</tbody></table>
<p class="total">Total ${aud(invoice.totalCents)}</p><p style="text-align:right">Includes GST ${aud(invoice.gstCents)}</p>
${howToPay}
${csv}
<p><small>Amounts are in AUD including GST. The care fee covers RealBud software and routine maintenance; credits and monthly rounding appear separately. ${aiNote} ${collected?`Accepted terms ${escape(invoice.commercialTerms!.version)} · ${escape(invoice.commercialTerms!.digest)}. Payment status and receipts are available in your RealBud account; this invoice alone is not a payment receipt.`:'This local document is for review and does not establish a payment.'}</small></p></html>`;
}

/**
 * How offices pay by transfer, shown with their invoices: PayID
 * (`REALBUD_PAYID`, `REALBUD_PAYID_NAME`) and bank account
 * (`REALBUD_BANK_ACCOUNT_NAME`, `REALBUD_BANK_BSB`, `REALBUD_BANK_ACCOUNT_NUMBER`).
 * Each part is null unless all of its variables are set and well formed, so an
 * office is never shown half an account.
 */
export function composePaymentInstructions(env:NodeJS.ProcessEnv): PaymentInstructions {
  const value = (name: string) => (env[name] ?? '').trim();
  const text = (v: string) => v.length > 0 && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v);
  const payId = value('REALBUD_PAYID'), payIdName = value('REALBUD_PAYID_NAME');
  const accountName = value('REALBUD_BANK_ACCOUNT_NAME'), bsb = value('REALBUD_BANK_BSB').replace(/[\s-]/g, ''), accountNumber = value('REALBUD_BANK_ACCOUNT_NUMBER').replace(/\s/g, '');
  return {
    payId: text(payId) && text(payIdName) ? { id: payId, name: payIdName } : null,
    bank: text(accountName) && /^\d{6}$/.test(bsb) && /^\d{4,10}$/.test(accountNumber) ? { accountName, bsb: `${bsb.slice(0, 3)}-${bsb.slice(3)}`, accountNumber } : null,
  };
}
