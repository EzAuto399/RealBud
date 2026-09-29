/**
 * Operator billing (owner decision, 29 September 2026,
 * `docs/decisions/2026-09-29-operator-billing.md`): the admin desk's view of every
 * RealBud invoice with its due date, payments and standing; recording a bank
 * transfer or PayID payment the operator has checked at the bank, and undoing a
 * mistaken record with a reason; and closing an office's month from the desk.
 *
 * Every write is append-only (`manual_payments`, `manual_payment_reversals`,
 * audited by `manual_payment_recorded` / `manual_payment_reversed` ledger
 * events) and names the authenticated operator. Nothing here pauses an office or
 * changes its AI access: non-payment is flagged only. Square payments settle only
 * by verified webhook and are never recorded or undone here.
 */
import { canonical, exact, GatewayError, id, object, requireThat } from './contracts.ts';
import type { OperatorPrincipal } from './operator-token.ts';
import { ensureManualPaymentTables, invoiceStanding, manualPayments, squarePayment, type BillingService, type Invoice, type InvoiceStatus,
  type ManualPayment, type ManualPaymentMethod, type ManualPaymentReversal } from './billing.ts';
import type { CommercialTerms } from './commercial-terms.ts';
import { closeOfficeMonth, type MonthClose, type OfficeBilling } from './office-ai-billing.ts';
import { periodAt } from './money.ts';

export interface OperatorPayment {
  id:string; method:'square'|ManualPaymentMethod; amountCents:string; receivedOn:string; reference:string|null; note:string|null;
  recordedBy:string|null; recordedAt:number; reversed:{reason:string;by:string;at:number}|null;
}
export interface OperatorInvoice {
  id:string; companyId:string; officeName:string; billingEmail:string|null; period:string; kind:Invoice['kind']; issuedAt:number; dueAt:number;
  totalCents:string; gstCents:string; paidCents:string; outstandingCents:string; status:InvoiceStatus; overdue:boolean; daysOverdue:number;
  payments:OperatorPayment[];
}
export interface CloseOffice { companyId:string; officeName:string; invoiceId:string|null; termsVersion:string|null; state:'closed'|'ready'|'blocked'; blocker:string|null }
export interface OperatorBillingRoutes {
  invoices():{now:number;invoices:OperatorInvoice[]};
  recordPayment(operator:OperatorPrincipal,invoiceId:string,value:unknown):OperatorInvoice;
  reversePayment(operator:OperatorPrincipal,invoiceId:string,paymentId:string,value:unknown):OperatorInvoice;
  closeList(period:string):{period:string;offices:CloseOffice[]};
  close(operator:OperatorPrincipal,value:unknown):Promise<{invoice:OperatorInvoice;ai:MonthClose['ai'];alreadyClosed:boolean}>;
}

const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const METHODS:readonly ManualPaymentMethod[]=['bank_transfer','payid','other'];
const LIST_LIMIT=500;
const brisbaneDate=(at:number)=>new Date(at+36_000_000).toISOString().slice(0,10);
/** Plain text: no control characters (a note may keep line breaks). */
const plain=(value:string,lineBreaks:boolean)=>!(lineBreaks?/[\u0000-\u0009\u000b-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(value);
function optionalText(value:unknown,max:number,lineBreaks:boolean,code:string):string|null {
  if(value===undefined || value===null) return null;
  requireThat(typeof value==='string' && value.length<=max && plain(value,lineBreaks),code);
  const trimmed=(value as string).trim(); return trimmed?trimmed:null;
}
function validDate(value:unknown):value is string {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at=Date.parse(`${value}T00:00:00Z`); return Number.isFinite(at) && new Date(at).toISOString().slice(0,10)===value;
}
function amount(value:unknown):string {
  const text=typeof value==='number' && Number.isSafeInteger(value)?String(value):value;
  requireThat(typeof text==='string' && /^[1-9][0-9]{0,14}$/.test(text),'invalid_amount');
  return text as string;
}
const officeName=(customer:{name:string;tradingName?:string})=>customer.tradingName||customer.name;

/** The operator's view of one invoice: its standing and every payment, Square and recorded. */
export function operatorInvoice(billing:BillingService,invoice:Invoice,now=billing.ledger.now()):OperatorInvoice {
  const ledger=billing.ledger, standing=invoiceStanding(ledger,invoice,now,billing.invoiceTermsDays);
  const payments:OperatorPayment[]=[];
  const square=squarePayment(ledger,invoice.id);
  if(square) payments.push({id:square.id,method:'square',amountCents:square.payment.amountCents,receivedOn:brisbaneDate(square.payment.settledAt),reference:square.payment.transactionId,note:null,
    recordedBy:null,recordedAt:square.payment.settledAt,reversed:null});
  for(const p of manualPayments(ledger,invoice.id)) payments.push({id:p.id,method:p.method,amountCents:p.amountCents,receivedOn:p.receivedOn,reference:p.reference,note:p.note,
    recordedBy:p.recordedBy,recordedAt:p.recordedAt,reversed:p.reversed?{reason:p.reversed.reason,by:p.reversed.by,at:p.reversed.at}:null});
  return {id:invoice.id,companyId:invoice.companyId,officeName:officeName(invoice.customer),billingEmail:invoice.customer.billingEmail??null,period:invoice.period,kind:invoice.kind,
    issuedAt:invoice.issuedAt,dueAt:standing.dueAt,totalCents:invoice.totalCents,gstCents:invoice.gstCents,paidCents:standing.paidCents,outstandingCents:standing.outstandingCents,
    status:standing.status,overdue:standing.overdue,daysOverdue:standing.daysOverdue,payments};
}

function storedInvoice(billing:BillingService,invoiceId:string):Invoice {
  requireThat(typeof invoiceId==='string' && /^[A-Za-z0-9-]{1,160}$/.test(invoiceId),'invoice_not_found',404);
  const row=billing.ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',invoiceId); requireThat(row,'invoice_not_found',404);
  return JSON.parse(row.body) as Invoice;
}

/** Record one bank transfer, PayID or other payment the operator checked at the
 * bank. Idempotent on `paymentId`: the same record again returns the invoice; a
 * different record under the same id is `payment_conflict`. */
export function recordManualPayment(billing:BillingService,operator:OperatorPrincipal,invoiceId:string,value:unknown):OperatorInvoice {
  object(value);
  exact(value,['paymentId','method','amountCents','receivedOn',...(value.reference!==undefined?['reference']:[]),...(value.note!==undefined?['note']:[])]);
  requireThat(typeof value.paymentId==='string' && UUID.test(value.paymentId),'invalid_payment_id');
  requireThat(typeof value.method==='string' && (METHODS as readonly string[]).includes(value.method),'invalid_payment_method');
  const amountCents=amount(value.amountCents);
  const ledger=billing.ledger, now=ledger.now();
  // Brisbane's calendar date: a payment cannot be received after today.
  requireThat(validDate(value.receivedOn) && value.receivedOn<=brisbaneDate(now),'invalid_received_on');
  const reference=optionalText(value.reference,120,false,'invalid_reference'), note=optionalText(value.note,500,true,'invalid_note');
  const record={id:value.paymentId as string,invoiceId,method:value.method as ManualPaymentMethod,amountCents,receivedOn:value.receivedOn as string,reference,note};
  ensureManualPaymentTables(ledger);
  ledger.db.transaction(()=>{
    const invoice=storedInvoice(billing,invoiceId);
    const prior=ledger.db.get<{body:string}>('SELECT body FROM manual_payments WHERE id=?',record.id);
    if(prior) {
      const saved=JSON.parse(prior.body) as ManualPayment;
      requireThat(canonical({id:saved.id,invoiceId:saved.invoiceId,method:saved.method,amountCents:saved.amountCents,receivedOn:saved.receivedOn,reference:saved.reference,note:saved.note})===canonical(record),'payment_conflict',409);
      return;
    }
    requireThat(invoice.kind==='Tax Invoice' && BigInt(invoice.totalCents)>0n,'nothing_to_pay',409);
    requireThat(!squarePayment(ledger,invoiceId),'invoice_already_paid',409);
    const standing=invoiceStanding(ledger,invoice,now,billing.invoiceTermsDays);
    requireThat(BigInt(amountCents)<=BigInt(standing.outstandingCents),'payment_exceeds_outstanding',409);
    const payment:ManualPayment={...record,recordedBy:operator.subject,recordedAt:now};
    ledger.db.run('INSERT INTO manual_payments(id,invoice,body) VALUES(?,?,?)',payment.id,invoiceId,canonical(payment));
    ledger.db.append(invoice.companyId,'manual_payment_recorded',null,now,payment);
  });
  return operatorInvoice(billing,storedInvoice(billing,invoiceId),now);
}

/** Undo one recorded payment with a reason: appends a reversal, deletes nothing.
 * Square payments are refunded through Square, never undone here. Idempotent. */
export function reverseManualPayment(billing:BillingService,operator:OperatorPrincipal,invoiceId:string,paymentId:string,value:unknown):OperatorInvoice {
  object(value); exact(value,['reason']);
  requireThat(typeof value.reason==='string' && plain(value.reason,false),'invalid_reason');
  const reason=value.reason.trim(); requireThat(reason.length>=3 && reason.length<=300,'invalid_reason');
  const ledger=billing.ledger, now=ledger.now();
  ensureManualPaymentTables(ledger);
  ledger.db.transaction(()=>{
    const invoice=storedInvoice(billing,invoiceId);
    const square=squarePayment(ledger,invoiceId);
    requireThat(!square || square.id!==paymentId,'square_payment_not_reversible',409);
    const row=ledger.db.get<{body:string}>('SELECT body FROM manual_payments WHERE id=? AND invoice=?',paymentId,invoiceId); requireThat(row,'payment_not_found',404);
    const prior=ledger.db.get<{body:string}>('SELECT body FROM manual_payment_reversals WHERE payment=?',paymentId);
    if(prior) { requireThat((JSON.parse(prior.body) as ManualPaymentReversal).reason===reason,'reversal_conflict',409); return; }
    const reversal:ManualPaymentReversal={paymentId,reason,by:operator.subject,at:now};
    ledger.db.run('INSERT INTO manual_payment_reversals(payment,body) VALUES(?,?)',paymentId,canonical(reversal));
    ledger.db.append(invoice.companyId,'manual_payment_reversed',null,now,{invoiceId,...reversal});
  });
  return operatorInvoice(billing,storedInvoice(billing,invoiceId),now);
}

/** Every invoice, newest first, at most 500. */
export function operatorInvoices(billing:BillingService):{now:number;invoices:OperatorInvoice[]} {
  const now=billing.ledger.now();
  const rows=billing.ledger.db.all<{body:string}>('SELECT body FROM invoices ORDER BY id DESC LIMIT ?',LIST_LIMIT);
  return {now,invoices:rows.map(row=>operatorInvoice(billing,JSON.parse(row.body) as Invoice,now))};
}

type Resolved={termsVersion:string|null;officeName:string|null;blocker:string|null};
/** The terms version a web close uses: the month's latest terms, when the office's
 * billing owner accepted exactly that version. None accepted: `terms_not_accepted`.
 * An earlier version accepted but a newer one published and not accepted:
 * `terms_version_ambiguous` (the office must accept the current version). Then
 * the same admission the close itself checks, reported as its code. */
function resolveTerms(billing:BillingService,companyId:string,period:string):Resolved {
  const ledger=billing.ledger;
  const latest=ledger.db.get<{version:string;body:string}>('SELECT version,body FROM commercial_terms WHERE tenant=? AND period=? ORDER BY seq DESC LIMIT 1',companyId,period);
  const name=latest?officeName((JSON.parse(latest.body) as CommercialTerms).customer):null;
  const accepted=new Set(ledger.db.all<{version:string}>('SELECT version FROM commercial_acceptances WHERE tenant=? AND period=?',companyId,period).map(r=>r.version));
  if(!latest || !accepted.size) return {termsVersion:null,officeName:name,blocker:'terms_not_accepted'};
  if(!accepted.has(latest.version)) return {termsVersion:null,officeName:name,blocker:'terms_version_ambiguous'};
  const block=(blocker:string):Resolved=>({termsVersion:latest.version,officeName:name,blocker});
  if(!(period<periodAt(ledger.now()))) return block('month_not_closed');
  try {
    requireThat(billing.commercialTerms,'commercial_terms_unavailable',503);
    billing.commercialTerms.accepted(companyId,period,latest.version);
    const tenant=ledger.tenant(companyId);
    requireThat(period>=periodAt(tenant.goLiveAt),'period_before_go_live',409);
    requireThat(!ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND period>?',companyId,period),'invoice_period_out_of_order',409);
  } catch(error) { return block(error instanceof GatewayError?error.code:'close_blocked'); }
  return {termsVersion:latest.version,officeName:name,blocker:null};
}

/** Offices with commercial terms, and whether each month can close. Reads the
 * ledger only; whether Modelvia has finalized the month is found at close. */
export function closeList(billing:BillingService,period:string):{period:string;offices:CloseOffice[]} {
  requireThat(typeof period==='string' && MONTH.test(period),'invalid_billing_period');
  const ledger=billing.ledger, internal=billing.commercialTerms?.internalCompanyId;
  const tenants=ledger.db.all<{body:string}>('SELECT t.body FROM tenants t WHERE EXISTS(SELECT 1 FROM commercial_terms c WHERE c.tenant=t.id) ORDER BY t.id')
    .map(row=>JSON.parse(row.body) as {companyId:string;customerName:string;billingMode?:string})
    .filter(t=>t.companyId!==internal && t.billingMode!=='internal_cost');
  const offices=tenants.map((tenant):CloseOffice=>{
    const row=ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE tenant=? AND period=?',tenant.companyId,period);
    if(row) { const invoice=JSON.parse(row.body) as Invoice;
      return {companyId:tenant.companyId,officeName:officeName(invoice.customer),invoiceId:invoice.id,termsVersion:invoice.commercialTerms?.version??null,state:'closed',blocker:null}; }
    const resolved=resolveTerms(billing,tenant.companyId,period);
    return {companyId:tenant.companyId,officeName:resolved.officeName??tenant.customerName,invoiceId:null,termsVersion:resolved.termsVersion,state:resolved.blocker?'blocked':'ready',blocker:resolved.blocker};
  });
  return {period,offices};
}

/** Close one office's month from the desk, as `commercial-cli.ts close` does:
 * the terms version is resolved here, never taken from the body. A month closed
 * already returns its invoice. The invoice email is queued by the close and
 * delivered by the server's drain. */
export async function closeMonth(options:OfficeBilling&{policyUnavailable?:string},operator:OperatorPrincipal,value:unknown) {
  object(value); exact(value,['companyId','period',...(value.deferAi!==undefined?['deferAi']:[])]);
  id(value.companyId); requireThat(typeof value.period==='string' && MONTH.test(value.period),'invalid_billing_period');
  requireThat(value.deferAi===undefined || typeof value.deferAi==='boolean','invalid_defer_ai');
  const {billing}=options, companyId=value.companyId, period=value.period as string;
  const existing=billing.ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE tenant=? AND period=?',companyId,period);
  let termsVersion:string;
  if(existing) {
    const version=(JSON.parse(existing.body) as Invoice).commercialTerms?.version; requireThat(version,'invoice_close_conflict',409); termsVersion=version;
  } else {
    requireThat(!options.policyUnavailable,options.policyUnavailable??'',503);
    const resolved=resolveTerms(billing,companyId,period);
    if(resolved.blocker) throw new GatewayError(resolved.blocker,resolved.blocker==='commercial_terms_unavailable'?503:409);
    termsVersion=resolved.termsVersion!;
  }
  const closed=await closeOfficeMonth(options,companyId,period,termsVersion,{deferAi:value.deferAi===true});
  if(closed.ai!=='already_closed') billing.ledger.db.transaction(()=>billing.ledger.db.append(companyId,'operator_month_closed',null,billing.ledger.now(),{invoiceId:closed.invoice.id,period,termsVersion,ai:closed.ai,by:operator.subject}));
  return {invoice:operatorInvoice(billing,closed.invoice),ai:closed.ai,alreadyClosed:closed.ai==='already_closed'};
}

/** The operator billing routes over one billing service. */
export function operatorBillingRoutes(options:OfficeBilling&{policyUnavailable?:string}):OperatorBillingRoutes {
  const {billing}=options;
  return {
    invoices:()=>operatorInvoices(billing),
    recordPayment:(operator,invoiceId,value)=>recordManualPayment(billing,operator,invoiceId,value),
    reversePayment:(operator,invoiceId,paymentId,value)=>reverseManualPayment(billing,operator,invoiceId,paymentId,value),
    closeList:period=>closeList(billing,period),
    close:(operator,value)=>closeMonth(options,operator,value),
  };
}
