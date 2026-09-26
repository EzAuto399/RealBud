/**
 * The office's monthly RealBud invoice. One closed invoice per office and month,
 * holding the care line from the office's accepted commercial terms
 * (`commercial-terms.ts`), any care credits carried forward and, for an office
 * that accepted AI resale (owner decision, 26 September 2026), one "AI usage"
 * line per finalized Modelvia customer invoice consolidated into it, collected
 * as ONE amount through Square (`square-payment.ts`). AI amounts are Modelvia's
 * exact invoice totals and GST (`office-ai-billing.ts` fetches them); nothing
 * here reads the gateway's legacy AI usage, rate cards or request history.
 */
import { randomUUID } from 'node:crypto';
import { canonical, id, integer, nano, requireThat, type PortalPrincipal } from './contracts.ts';
import { digest, UsageLedger } from './ledger.ts';
import { cents, gstCents, periodAt } from './money.ts';
import { CommercialTermsStore } from './commercial-terms.ts';

export interface InvoiceLine { description:string; amountNanoAud:string; amountCents:string; gstCents:string; creditId?:string; sourceInvoice?:string;
  /** An AI usage line: the Modelvia customer invoice it consolidates, at that invoice's exact total and GST. */
  modelviaInvoice?:string }
/** One finalized Modelvia customer invoice consolidated into a RealBud invoice. */
export interface ConsolidatedAiInvoice { id:string; period:string; totalCents:string; gstCents:string }
export interface Invoice {
  id:string; kind:'Tax Invoice'|'Adjustment Note'; mode:'local'|'commercial'; companyId:string; period:string; issuedAt:number;
  supplier:{legalName:string;product:'RealBud';abn:string;gstRegistered:true;address?:string}; customer:{name:string;address:string;abn?:string}; currency:'AUD'; gstInclusive:true;
  lines:InvoiceLine[]; totalCents:string; gstCents:string; careAgreementRef:string|null;
  sourceEventIds:number[];
  /** Absent only on a historical local invoice row; every invoice closed here carries it. */
  commercialTerms?:{version:string;digest:string;acceptanceDigest:string;sellerBasisDigest:string};
  /** Present only when AI resale was billed or deferred on this invoice. Absent
   * on care-only invoices, so their shape and digest are unchanged. */
  aiUsage?:{modelviaInvoices:ConsolidatedAiInvoice[];deferredPeriods?:string[]};
}
export interface HostedCheckout { sessionId:string; url:string; expiresAt:number }
export interface CheckoutRequest { companyId:string; invoiceId:string; attemptId:string; amountCents:string; currency:'AUD'; idempotencyKey:string }
export interface VerifiedPayment {
  eventId:string; transactionId:string; invoiceId:string; attemptId:string; sessionId:string;
  amountCents:string; currency:'AUD'; settledAt:number;
}
export interface RefundRequest { refundId:string; transactionId:string; amountCents:string; currency:'AUD'; idempotencyKey:string }
export interface VerifiedRefund { eventId:string; refundId:string; providerRefundId:string; transactionId:string; amountCents:string; currency:'AUD'; settledAt:number }
export interface HostedPaymentAdapter {
  readonly id:string; readonly mode:'sandbox'|'live';
  /** Pure local policy check before persisting an uncertain checkout intent. */
  preflightCheckout?(request:Pick<CheckoutRequest,'companyId'|'invoiceId'|'amountCents'>):void;
  createCheckout(request:CheckoutRequest):Promise<HostedCheckout>;
  /** Must authenticate exact raw bytes, enforce signature age/account/environment,
   * and return only verified successful settlement. Failed/pending events return null. */
  verifyWebhook(raw:Uint8Array, signature:string, now:number):Promise<VerifiedPayment|null>;
  requestRefund(request:RefundRequest):Promise<void>;
  verifyRefundWebhook(raw:Uint8Array,signature:string,now:number):Promise<VerifiedRefund|null>;
}
type StoredCheckout = {attemptId:string;amountCents:string;provider:string;session?:HostedCheckout};
type EventRow = {seq:number;kind:string;request:string|null;body:string};
type CareCredit = {creditId:string;invoiceId:string;period:string;amountCents:string;amountNanoAud:string;reason:string};

export class BillingService {
  readonly ledger:UsageLedger;
  private readonly payment:HostedPaymentAdapter|undefined;
  readonly commercialTerms:CommercialTermsStore|undefined;
  private readonly internalCompanyId:string|undefined;
  /** A payment adapter is only ever sandbox or live, so it requires
   * `authorizeCollection: true` from the deployment composition after the Square
   * variables are checked — never from a test import. Without an adapter,
   * invoices still close and read; checkout answers `payment_provider_unselected`. */
  constructor(ledger:UsageLedger, payment?:HostedPaymentAdapter, options:{authorizeCollection?:boolean;internalCompanyId?:string}={}) {
    requireThat(!payment || options.authorizeCollection===true,'payment_collection_not_authorized',403);
    this.ledger=ledger; this.payment=payment; this.internalCompanyId=options.internalCompanyId;
    this.commercialTerms=options.internalCompanyId?new CommercialTermsStore(ledger,options.internalCompanyId):undefined;
  }
  /** Care credits not yet applied to an invoice or reserved for a refund. */
  private unappliedCareCredits(companyId:string,period:string):EventRow[] {
    return this.ledger.db.all<EventRow>(`SELECT e.seq,e.kind,e.request,e.body FROM events e LEFT JOIN invoice_events i ON i.event=e.seq
      WHERE e.tenant=? AND e.kind='care_credit' AND i.event IS NULL
      AND NOT EXISTS(SELECT 1 FROM refund_intents f WHERE f.credit_event=e.seq) ORDER BY e.seq`,companyId)
      .filter(e=>(JSON.parse(e.body) as CareCredit).period<=period);
  }
  /** Explicit operator close (`commercial-cli.ts close`). Never schedules, emails
   * or sends an invoice. The care amount and agreement reference come from the
   * terms the office's billing owner accepted for this exact month; nothing is
   * inferred, prorated or read from usage. */
  finalizeCommercialInvoice(companyId:string,period:string,termsVersion:string,ai?:{invoices:ConsolidatedAiInvoice[];deferredPeriods?:string[]},report?:{existing?:boolean}):Invoice {
    requireThat(this.commercialTerms,'commercial_terms_unavailable',503);
    [companyId,termsVersion].forEach(id);
    requireThat(!this.internalCompanyId || companyId!==this.internalCompanyId,'internal_usage_not_billable',403);
    requireThat(/^\d{4}-(0[1-9]|1[0-2])$/.test(period) && period<periodAt(this.ledger.now()),'month_not_closed',409);
    const aiInvoices=ai?.invoices??[];
    for(const entry of aiInvoices) requireThat(/^[A-Za-z0-9][A-Za-z0-9-]{0,159}$/.test(entry.id) && /^\d{4}-(0[1-9]|1[0-2])$/.test(entry.period) && entry.period<=period
      && /^-?(0|[1-9][0-9]{0,14})$/.test(entry.totalCents) && /^-?(0|[1-9][0-9]{0,14})$/.test(entry.gstCents),'invalid_ai_invoice',409);
    requireThat(new Set(aiInvoices.map(entry=>entry.id)).size===aiInvoices.length,'invalid_ai_invoice',409);
    if(ai) ensureAiConsolidationTable(this.ledger);
    return this.ledger.db.transaction(()=>{
      const tenant=this.ledger.tenant(companyId);
      requireThat(tenant.billingMode!=='internal_cost','internal_usage_not_billable',403);
      const accepted=this.commercialTerms!.accepted(companyId,period,termsVersion);
      const terms=accepted.terms;
      const existing=this.ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE tenant=? AND period=?',companyId,period);
      if(existing) { const invoice:Invoice=JSON.parse(existing.body); requireThat(invoice.commercialTerms?.version===termsVersion,'invoice_close_conflict',409); if(report) report.existing=true; return invoice; }
      requireThat(period>=periodAt(tenant.goLiveAt),'period_before_go_live',409);
      // AI resale only under terms that carry it, and each Modelvia invoice at most once, ever.
      requireThat(!ai || terms.aiUsage,'ai_usage_not_accepted',409);
      for(const entry of aiInvoices) requireThat(!this.ledger.db.get('SELECT modelvia_invoice FROM office_ai_consolidations WHERE modelvia_invoice=?',entry.id),'modelvia_invoice_already_consolidated',409);
      // Closing must move forwards: late credits are carried to the next invoice.
      requireThat(!this.ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND period>?',companyId,period),'invoice_period_out_of_order',409);
      const credits=this.unappliedCareCredits(companyId,period); const lines:InvoiceLine[]=[];
      const add=(line:Omit<InvoiceLine,'amountCents'|'gstCents'>)=>{
        const c=cents(BigInt(line.amountNanoAud)); lines.push({...line,amountCents:c.toString(),gstCents:gstCents(c).toString()});
      };
      const care=BigInt(terms.careCents);
      if(care>0n) add({description:'RealBud software and routine maintenance — monthly care',amountNanoAud:(care*10_000_000n).toString()});
      // Exact cents and GST from the Modelvia invoice; never re-rounded here.
      for(const entry of aiInvoices) lines.push({description:`AI usage ${entry.period} (Modelvia invoice ${entry.id})`,amountNanoAud:(BigInt(entry.totalCents)*10_000_000n).toString(),amountCents:entry.totalCents,gstCents:entry.gstCents,modelviaInvoice:entry.id});
      for(const e of credits) { const data=JSON.parse(e.body) as CareCredit; add({description:'Care credit',amountNanoAud:(-nano(data.amountNanoAud)).toString(),creditId:data.creditId,sourceInvoice:data.invoiceId}); }
      const totalNano=lines.reduce((s,l)=>s+BigInt(l.amountNanoAud),0n); const total=cents(totalNano);
      const roundedLines=lines.reduce((s,l)=>s+BigInt(l.amountCents),0n);
      if(roundedLines!==total) lines.push({description:'Monthly rounding adjustment',amountNanoAud:'0',amountCents:(total-roundedLines).toString(),gstCents:'0'});
      // The invoice GST is Square's inclusive GST on the one collected total.
      const gst=gstCents(total), lineGst=lines.reduce((s,l)=>s+BigInt(l.gstCents),0n), drift=gst-lineGst;
      if(aiInvoices.length) {
        // An AI line always keeps the GST printed on its Modelvia invoice. The
        // difference from rounding the one total is at most a cent (care and one
        // Modelvia invoice each round by up to half a cent); anything larger means
        // the documents disagree and is refused rather than hidden on a line.
        requireThat(drift>=-1n && drift<=1n,'gst_reconciliation_required',409);
        if(drift!==0n) {
          let target=lines.findLastIndex(l=>!l.modelviaInvoice);
          if(target<0) { lines.push({description:'GST rounding adjustment',amountNanoAud:'0',amountCents:'0',gstCents:'0'}); target=lines.length-1; }
          lines[target].gstCents=(BigInt(lines[target].gstCents)+drift).toString();
        }
      } else if(lines.length) lines[lines.length-1].gstCents=(BigInt(lines.at(-1)!.gstCents)+drift).toString();
      // The sequence key and event kind keep their historical names so an older ledger reads unchanged.
      const next=Number(this.ledger.db.get<{value:string}>("SELECT value FROM settings WHERE key='local_invoice_sequence'")?.value??'0')+1;
      const invoice:Invoice={id:`RB-${String(next).padStart(6,'0')}`,kind:total<0n?'Adjustment Note':'Tax Invoice',mode:'commercial',companyId,period,issuedAt:this.ledger.now(),supplier:terms.seller,customer:terms.customer,currency:'AUD',gstInclusive:true,lines,totalCents:total.toString(),gstCents:gst.toString(),careAgreementRef:terms.careAgreementRef,sourceEventIds:credits.map(e=>e.seq),commercialTerms:{version:terms.version,digest:accepted.digest,acceptanceDigest:digest(accepted.acceptance),sellerBasisDigest:this.commercialTerms!.sellerBasisDigest(terms)},
        ...(ai && (aiInvoices.length || ai.deferredPeriods?.length)?{aiUsage:{modelviaInvoices:aiInvoices.map(({id,period,totalCents,gstCents})=>({id,period,totalCents,gstCents})),...(ai.deferredPeriods?.length?{deferredPeriods:[...ai.deferredPeriods]}:{})}}:{})};
      this.ledger.db.run("INSERT INTO settings(key,value) VALUES('local_invoice_sequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(next));
      this.ledger.db.run('INSERT INTO invoices(id,tenant,period,body) VALUES(?,?,?,?)',invoice.id,companyId,period,canonical(invoice));
      for(const e of credits) this.ledger.db.run('INSERT INTO invoice_events(event,invoice) VALUES(?,?)',e.seq,invoice.id);
      // Reconciliation: which Modelvia invoice went onto which RealBud invoice.
      // The primary key is the Modelvia invoice id, so it can never be billed twice.
      for(const entry of aiInvoices) this.ledger.db.run('INSERT INTO office_ai_consolidations(modelvia_invoice,tenant,period,invoice,body) VALUES(?,?,?,?,?)',entry.id,companyId,period,invoice.id,canonical(entry));
      if(invoice.aiUsage) this.ledger.db.append(companyId,'ai_usage_consolidated',null,this.ledger.now(),{invoiceId:invoice.id,period,...invoice.aiUsage});
      this.commercialTerms!.bindInvoice(invoice);
      this.ledger.db.append(companyId,'local_invoice_closed',null,this.ledger.now(),{invoiceId:invoice.id,totalCents:invoice.totalCents,digest:digest(invoice)});
      return invoice;
    });
  }
  /** Operator-only care credit against one closed care invoice (`commercial-cli.ts
   * credit`): a goodwill or correction credit, audited, never an unapproved debit.
   * It is applied to the office's next invoice or refunded through Square
   * (`refundCareCredit`), never both. The credited invoice stays immutable. */
  creditCare(companyId:string,invoiceId:string,creditId:string,amountCents:string,reason:string) {
    [companyId,invoiceId,creditId,reason].forEach(id);
    requireThat(/^[1-9][0-9]{0,14}$/.test(amountCents),'invalid_credit');
    return this.ledger.db.transaction(()=>{
      const row=this.ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE id=? AND tenant=?',invoiceId,companyId); requireThat(row,'invoice_not_found',404);
      const invoice:Invoice=JSON.parse(row.body); requireThat(invoice.kind==='Tax Invoice','credit_requires_tax_invoice',409);
      const credits=this.ledger.db.all<{body:string}>("SELECT body FROM events WHERE tenant=? AND kind='care_credit'",companyId).map(r=>JSON.parse(r.body) as CareCredit);
      const prior=credits.find(c=>c.creditId===creditId);
      if(prior) { requireThat(prior.invoiceId===invoiceId && prior.amountCents===amountCents && prior.reason===reason,'credit_conflict',409); return {duplicate:true}; }
      const credited=credits.filter(c=>c.invoiceId===invoiceId).reduce((sum,c)=>sum+BigInt(c.amountCents),0n);
      requireThat(credited+BigInt(amountCents)<=BigInt(invoice.totalCents),'credit_exceeds_charge',409);
      const credit:CareCredit={creditId,invoiceId,period:invoice.period,amountCents,amountNanoAud:(BigInt(amountCents)*10_000_000n).toString(),reason};
      this.ledger.db.append(companyId,'care_credit',null,this.ledger.now(),credit);
      return {duplicate:false};
    });
  }
  invoice(actor:PortalPrincipal,invoiceId:string):Invoice {
    const row=this.ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE tenant=? AND id=?',actor.companyId,invoiceId); requireThat(row,'invoice_not_found',404); return JSON.parse(row.body);
  }
  invoices(actor:PortalPrincipal):Invoice[] { return this.ledger.db.all<{body:string}>('SELECT body FROM invoices WHERE tenant=? ORDER BY id',actor.companyId).map(r=>JSON.parse(r.body)); }
  /** Tenant-scoped list for the website. Paid is a settlement flag, not a provider receipt. */
  portalInvoices(actor:PortalPrincipal) {
    const paid=new Set(this.ledger.db.all<{invoice:string}>('SELECT p.invoice FROM payments p JOIN invoices i ON i.id=p.invoice WHERE i.tenant=?',actor.companyId).map(r=>r.invoice));
    return this.invoices(actor).map(inv=>({id:inv.id,kind:inv.kind,period:inv.period,currency:inv.currency,gstInclusive:inv.gstInclusive,totalCents:inv.totalCents,gstCents:inv.gstCents,paid:paid.has(inv.id)}));
  }
  async checkout(actor:PortalPrincipal,invoiceId:string):Promise<HostedCheckout> {
    requireThat(actor.role==='billing_owner','forbidden',403); requireThat(this.payment,'payment_provider_unselected',503);
    const invoice=this.invoice(actor,invoiceId); requireThat(BigInt(invoice.totalCents)>0n,'nothing_to_pay',409);
    this.payment.preflightCheckout?.({companyId:actor.companyId,invoiceId,amountCents:invoice.totalCents});
    const admission=this.ledger.db.transaction(()=>{
      requireThat(!this.ledger.db.get('SELECT id FROM payments WHERE invoice=?',invoiceId),'invoice_already_paid',409);
      const prior=this.ledger.db.get<{state:string;body:string}>('SELECT state,body FROM checkouts WHERE invoice=?',invoiceId);
      if(prior) { const data:StoredCheckout=JSON.parse(prior.body);
        requireThat(prior.state==='ready' && data.session && data.session.expiresAt>this.ledger.now(),'checkout_reconciliation_required',409);
        return {data,duplicate:true};
      }
      const data:StoredCheckout={attemptId:randomUUID(),amountCents:invoice.totalCents,provider:this.payment!.id};
      this.ledger.db.run('INSERT INTO checkouts(invoice,state,body) VALUES(?,?,?)',invoiceId,'creating',canonical(data));
      this.ledger.db.append(actor.companyId,'checkout_requested',null,this.ledger.now(),{invoiceId,attemptId:data.attemptId}); return {data,duplicate:false};
    });
    if(admission.duplicate) return admission.data.session!;
    try {
      const session=await this.payment.createCheckout({companyId:actor.companyId,invoiceId,attemptId:admission.data.attemptId,amountCents:invoice.totalCents,currency:'AUD',idempotencyKey:`checkout:${invoiceId}`});
      id(session.sessionId); requireThat(new URL(session.url).protocol==='https:' && session.expiresAt>this.ledger.now(),'invalid_checkout_response',502);
      this.ledger.db.transaction(()=>{
        const state=this.ledger.db.get<{state:string}>('SELECT state FROM checkouts WHERE invoice=?',invoiceId);
        if(state?.state==='settled') return;
        this.ledger.db.run('UPDATE checkouts SET state=?,body=? WHERE invoice=?','ready',canonical({...admission.data,session}),invoiceId);
      }); return session;
    } catch {
      this.ledger.db.transaction(()=>{ this.ledger.db.run("UPDATE checkouts SET state='unknown' WHERE invoice=? AND state='creating'",invoiceId); });
      requireThat(false,'checkout_reconciliation_required',502);
    }
  }
  async webhook(raw:Uint8Array,signature:string) {
    requireThat(this.payment,'payment_provider_unselected',503); requireThat(raw.byteLength<=256_000,'webhook_too_large',413);
    const event=await this.payment.verifyWebhook(raw,signature,this.ledger.now()); if(!event) return {ignored:true};
    return this.recordVerifiedPayment(this.payment.id,event);
  }
  private recordVerifiedPayment(provider:string,event:VerifiedPayment) {
    [provider,event.eventId,event.transactionId,event.invoiceId,event.attemptId,event.sessionId].forEach(id);
    requireThat(event.currency==='AUD' && /^[1-9][0-9]{0,14}$/.test(event.amountCents) && Number.isSafeInteger(event.settledAt) && event.settledAt>0 && event.settledAt<=this.ledger.now(),'invalid_settlement');
    return this.ledger.db.transaction(()=>{
      const key=`${provider}:${event.eventId}`, hash=digest(event); const old=this.ledger.db.get<{digest:string}>('SELECT digest FROM payment_events WHERE id=?',key);
      if(old) { requireThat(old.digest===hash,'payment_event_conflict',409); return {duplicate:true}; }
      const checkout=this.ledger.db.get<{body:string}>('SELECT body FROM checkouts WHERE invoice=?',event.invoiceId); requireThat(checkout,'unknown_checkout',409);
      const saved:StoredCheckout=JSON.parse(checkout.body);
      requireThat(saved.provider===provider && saved.attemptId===event.attemptId && saved.amountCents===event.amountCents && (!saved.session || saved.session.sessionId===event.sessionId),'settlement_mismatch',409);
      const transactionKey=`${provider}:${event.transactionId}`;
      const payment=this.ledger.db.get<{invoice:string;body:string}>('SELECT invoice,body FROM payments WHERE id=? OR invoice=?',transactionKey,event.invoiceId);
      if(payment) { const p:VerifiedPayment=JSON.parse(payment.body); requireThat(payment.invoice===event.invoiceId && p.transactionId===event.transactionId && p.amountCents===event.amountCents && p.sessionId===event.sessionId,'duplicate_payment_conflict',409); }
      else {
        this.ledger.db.run('INSERT INTO payments(id,invoice,body) VALUES(?,?,?)',transactionKey,event.invoiceId,canonical(event));
        const tenant=this.ledger.db.get<{tenant:string}>('SELECT tenant FROM invoices WHERE id=?',event.invoiceId)!.tenant;
        this.ledger.db.append(tenant,'payment_settled',null,this.ledger.now(),{invoiceId:event.invoiceId,receiptId:transactionKey,amountCents:event.amountCents,settledAt:event.settledAt,mode:provider});
      }
      this.ledger.db.run('INSERT INTO payment_events(id,digest) VALUES(?,?)',key,hash);
      this.ledger.db.run("UPDATE checkouts SET state='settled' WHERE invoice=?",event.invoiceId); return {duplicate:!!payment};
    });
  }
  receipt(actor:PortalPrincipal,invoiceId:string) {
    this.invoice(actor,invoiceId); const row=this.ledger.db.get<{id:string;body:string}>('SELECT id,body FROM payments WHERE invoice=?',invoiceId); requireThat(row,'payment_not_settled',409);
    const p:VerifiedPayment=JSON.parse(row.body);
    const refunded=this.ledger.db.all<{body:string}>('SELECT body FROM refunds WHERE payment=?',row.id).reduce((sum,r)=>sum+BigInt(JSON.parse(r.body).amountCents),0n);
    const provider=row.id.slice(0,row.id.indexOf(':'));
    const mode=provider==='square-sandbox'?'sandbox':provider==='square-live'?'live':'unknown';
    return {mode,invoiceId,receiptId:`receipt-${invoiceId}`,currency:'AUD',amountCents:p.amountCents,refundedCents:refunded.toString(),settledAt:p.settledAt};
  }
  /** Operator-only, explicit refund of an existing unapplied care credit against a
   * settled payment. Reserving its disposition prevents both an invoice credit
   * and a cash refund. An uncertain refund is held for reconciliation and never
   * automatically replayed. */
  async refundCareCredit(companyId:string,creditEventId:number,refundId:string) {
    id(refundId); integer(creditEventId,Number.MAX_SAFE_INTEGER); requireThat(this.payment,'payment_provider_unselected',503);
    const intent=this.ledger.db.transaction(()=>{
      const old=this.ledger.db.get('SELECT id FROM refund_intents WHERE id=? OR credit_event=?',refundId,creditEventId);
      requireThat(!old,'refund_reconciliation_required',409);
      const credit=this.ledger.db.get<EventRow>("SELECT seq,kind,request,body FROM events WHERE seq=? AND tenant=? AND kind='care_credit'",creditEventId,companyId);
      requireThat(credit,'credit_not_found',404); requireThat(!this.ledger.db.get('SELECT event FROM invoice_events WHERE event=?',creditEventId),'credit_already_applied',409);
      const data=JSON.parse(credit.body) as CareCredit;
      const payment=this.ledger.db.get<{id:string;body:string}>('SELECT id,body FROM payments WHERE invoice=?',data.invoiceId); requireThat(payment,'payment_not_settled',409);
      const paid:VerifiedPayment=JSON.parse(payment.body);
      const held=this.ledger.db.all<{body:string}>('SELECT body FROM refund_intents WHERE payment=?',payment.id).reduce((sum,r)=>sum+BigInt(JSON.parse(r.body).amountCents),0n);
      requireThat(held+BigInt(data.amountCents)<=BigInt(paid.amountCents),'refund_exceeds_payment',409);
      const request:RefundRequest={refundId,transactionId:paid.transactionId,amountCents:data.amountCents,currency:'AUD',idempotencyKey:`refund:${refundId}`};
      this.ledger.db.run('INSERT INTO refund_intents(id,tenant,payment,credit_event,body) VALUES(?,?,?,?,?)',refundId,companyId,payment.id,creditEventId,canonical(request));
      this.ledger.db.append(companyId,'refund_requested',null,this.ledger.now(),{refundId,creditEventId,amountCents:data.amountCents}); return request;
    });
    try { await this.payment.requestRefund(intent); } catch { requireThat(false,'refund_reconciliation_required',502); }
    return {refundId,state:'pending_verified_settlement'};
  }
  async refundWebhook(raw:Uint8Array,signature:string) {
    requireThat(this.payment,'payment_provider_unselected',503); requireThat(raw.byteLength<=256_000,'webhook_too_large',413);
    const e=await this.payment.verifyRefundWebhook(raw,signature,this.ledger.now()); if(!e) return {ignored:true};
    [e.eventId,e.refundId,e.providerRefundId,e.transactionId].forEach(id); integer(e.settledAt,Number.MAX_SAFE_INTEGER);
    requireThat(e.currency==='AUD' && /^[1-9][0-9]{0,14}$/.test(e.amountCents) && e.settledAt<=this.ledger.now(),'invalid_refund');
    return this.ledger.db.transaction(()=>{
      const key=`${this.payment!.id}:refund:${e.eventId}`,hash=digest(e),existing=this.ledger.db.get<{digest:string}>('SELECT digest FROM payment_events WHERE id=?',key);
      if(existing) { requireThat(existing.digest===hash,'refund_event_conflict',409); return {duplicate:true}; }
      const row=this.ledger.db.get<{tenant:string;payment:string;body:string}>('SELECT tenant,payment,body FROM refund_intents WHERE id=?',e.refundId); requireThat(row,'unknown_refund',409);
      const request:RefundRequest=JSON.parse(row.body); requireThat(request.transactionId===e.transactionId && request.amountCents===e.amountCents,'refund_mismatch',409);
      const settled=this.ledger.db.get<{body:string}>('SELECT body FROM refunds WHERE id=?',e.refundId);
      if(settled) { const previous:VerifiedRefund=JSON.parse(settled.body); requireThat(previous.providerRefundId===e.providerRefundId && previous.amountCents===e.amountCents,'refund_conflict',409); }
      else {
        requireThat(!this.ledger.db.all<{body:string}>('SELECT body FROM refunds').some(r=>JSON.parse(r.body).providerRefundId===e.providerRefundId),'refund_transaction_reused',409);
        this.ledger.db.run('INSERT INTO refunds(id,payment,body) VALUES(?,?,?)',e.refundId,row.payment,canonical(e)); this.ledger.db.append(row.tenant,'refund_settled',null,this.ledger.now(),{refundId:e.refundId,amountCents:e.amountCents,settledAt:e.settledAt});
      }
      this.ledger.db.run('INSERT INTO payment_events(id,digest) VALUES(?,?)',key,hash); return {duplicate:!!settled};
    });
  }
}

/** Which Modelvia customer invoice was consolidated into which RealBud invoice.
 * Created on first use (like `office_modelvia_customer`), append-only. */
export function ensureAiConsolidationTable(ledger:UsageLedger) {
  ledger.db.sql.exec(`CREATE TABLE IF NOT EXISTS office_ai_consolidations (modelvia_invoice TEXT PRIMARY KEY, tenant TEXT NOT NULL, period TEXT NOT NULL, invoice TEXT NOT NULL REFERENCES invoices(id), body TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_office_ai_consolidations_UPDATE BEFORE UPDATE ON office_ai_consolidations BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_office_ai_consolidations_DELETE BEFORE DELETE ON office_ai_consolidations BEGIN SELECT RAISE(ABORT,'immutable_record'); END;`);
}
/** The Modelvia invoices already consolidated for one office, by id. */
export function consolidatedAiInvoices(ledger:UsageLedger,companyId:string):Map<string,{invoice:string;period:string}> {
  ensureAiConsolidationTable(ledger);
  return new Map(ledger.db.all<{modelvia_invoice:string;invoice:string;period:string}>('SELECT modelvia_invoice,invoice,period FROM office_ai_consolidations WHERE tenant=?',companyId)
    .map(row=>[row.modelvia_invoice,{invoice:row.invoice,period:row.period}]));
}
