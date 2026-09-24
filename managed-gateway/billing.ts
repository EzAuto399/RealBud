import { randomUUID } from 'node:crypto';
import { canonical, id, integer, nano, requireThat, type PortalPrincipal, type Units, type ModelRate } from './contracts.ts';
import { digest, UsageLedger } from './ledger.ts';
import { cents, gstCents, modelRate, periodAt } from './money.ts';

export const SUPPLIER = { legalName:'Yo-Da Lai', product:'RealBud', abn:'84992526369', gstRegistered:true } as const;
export const CARE_FEE_CENTS = 12_500;
export interface InvoiceLine {
  description:string; amountNanoAud:string; amountCents:string; gstCents:string;
  requestId?:string; rateVersion?:string; model?:string; units?:Units; rates?:ModelRate['units']; sourceInvoice?:string;
}
export interface Invoice {
  id:string; kind:'Tax Invoice'|'Adjustment Note'; mode:'local'; companyId:string; period:string; issuedAt:number;
  supplier:typeof SUPPLIER; customer:{name:string;address:string;abn?:string}; currency:'AUD'; gstInclusive:true;
  lines:InvoiceLine[]; totalCents:string; gstCents:string; careAgreementRef:string|null;
  sourceEventIds:number[];
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
  readonly id:string; readonly mode:'local'|'sandbox'|'live';
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

export class BillingService {
  readonly ledger:UsageLedger;
  private readonly payment:HostedPaymentAdapter|undefined;
  /** Local is always allowed. Sandbox/live require `authorizeCollection: true` from the
   * deployment entrypoint after secrets and Square account checks — never from a test import. */
  constructor(ledger:UsageLedger, payment?:HostedPaymentAdapter, options:{authorizeCollection?:boolean}={}) {
    requireThat(!payment || payment.mode==='local' || options.authorizeCollection===true,'payment_collection_not_authorized',403);
    this.ledger=ledger; this.payment=payment;
  }
  private unbilled(companyId:string,period:string):EventRow[] {
    return this.ledger.db.all<EventRow>(`SELECT e.seq,e.kind,e.request,e.body FROM events e LEFT JOIN invoice_events i ON i.event=e.seq
      WHERE e.tenant=? AND e.kind IN ('usage_settled','credit','report_usage_accepted') AND i.event IS NULL
      AND NOT EXISTS(SELECT 1 FROM refund_intents f WHERE f.credit_event=e.seq)
      AND NOT EXISTS(SELECT 1 FROM statement_events s WHERE s.event=e.seq) ORDER BY e.seq`,companyId)
      .filter(e=>JSON.parse(e.body).period<=period);
  }
  /** Explicit operator close. Never schedules, emails or sends an invoice.
   * Care is only included with a supplied agreement reference for this month.
   * No assumptions about partial-month care charges are made. */
  finalizeLocalInvoice(companyId:string,period:string,careAgreementRef:string|null=null):Invoice {
    requireThat(/^\d{4}-(0[1-9]|1[0-2])$/.test(period) && period<periodAt(this.ledger.now()),'month_not_closed',409);
    if(careAgreementRef!==null) id(careAgreementRef);
    return this.ledger.db.transaction(()=>{
      const existing=this.ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE tenant=? AND period=?',companyId,period);
      if(existing) { const invoice:Invoice=JSON.parse(existing.body); requireThat(invoice.careAgreementRef===careAgreementRef,'invoice_close_conflict',409); return invoice; }
      requireThat(!this.ledger.db.get('SELECT id FROM statements WHERE tenant=? AND period=?',companyId,period),'period_already_stated',409);
      const tenant=this.ledger.tenant(companyId);
      requireThat(period>=periodAt(tenant.goLiveAt),'period_before_go_live',409);
      requireThat(!this.ledger.requests(companyId).some(r=>r.period<=period && ['unknown','reserved','dispatched'].includes(r.state)),'unreconciled_usage',409);
      // Closing must move forwards: late credits are carried to the next invoice.
      requireThat(!this.ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND period>?',companyId,period),'invoice_period_out_of_order',409);
      const events=this.unbilled(companyId,period); const lines:InvoiceLine[]=[];
      const add=(line:Omit<InvoiceLine,'amountCents'|'gstCents'>)=>{
        const c=cents(BigInt(line.amountNanoAud)); lines.push({...line,amountCents:c.toString(),gstCents:gstCents(c).toString()});
      };
      for(const e of events) {
        const data=JSON.parse(e.body);
        if(e.kind==='credit') {
          const source=this.ledger.db.get<{invoice:string}>(`SELECT i.invoice FROM invoice_events i JOIN events e ON e.seq=i.event WHERE e.request=? AND e.kind='usage_settled'`,e.request);
          add({description:'AI usage credit',amountNanoAud:(-nano(data.amountNanoAud)).toString(),requestId:e.request!,sourceInvoice:source?.invoice});
        } else if(e.kind==='report_usage_accepted') {
          const amount=nano(data.chargedNanoAud);
          if(!data.included && amount===0n) continue;
          add({description:data.included?'AI usage — included period':`AI usage — ${data.model}`,amountNanoAud:amount.toString(),model:data.model,rateVersion:data.rateVersion,units:data.units});
        } else {
          const amount=nano(data.chargedNanoAud);
          if(!data.included && amount===0n) continue;
          const rate=modelRate(this.ledger.card(data.rateVersion),data.model);
          add({description:data.included?'AI usage — included period':`AI usage — ${rate.label}`,amountNanoAud:amount.toString(),requestId:e.request!,model:data.model,rateVersion:data.rateVersion,units:data.units,rates:rate.units});
        }
      }
      if(careAgreementRef) add({description:'RealBud software and routine maintenance — monthly care',amountNanoAud:(BigInt(CARE_FEE_CENTS)*10_000_000n).toString()});
      const totalNano=lines.reduce((s,l)=>s+BigInt(l.amountNanoAud),0n); const total=cents(totalNano);
      const roundedLines=lines.reduce((s,l)=>s+BigInt(l.amountCents),0n);
      if(roundedLines!==total) lines.push({description:'Monthly rounding adjustment',amountNanoAud:'0',amountCents:(total-roundedLines).toString(),gstCents:'0'});
      const gst=gstCents(total), lineGst=lines.reduce((s,l)=>s+BigInt(l.gstCents),0n);
      if(lines.length) lines[lines.length-1].gstCents=(BigInt(lines.at(-1)!.gstCents)+gst-lineGst).toString();
      const next=Number(this.ledger.db.get<{value:string}>("SELECT value FROM settings WHERE key='local_invoice_sequence'")?.value??'0')+1;
      const invoice:Invoice={id:`RB-LOCAL-${String(next).padStart(6,'0')}`,kind:total<0n?'Adjustment Note':'Tax Invoice',mode:'local',companyId,period,issuedAt:this.ledger.now(),supplier:SUPPLIER,customer:{name:tenant.customerName,address:tenant.customerAddress,...(tenant.customerAbn?{abn:tenant.customerAbn}:{})},currency:'AUD',gstInclusive:true,lines,totalCents:total.toString(),gstCents:gst.toString(),careAgreementRef,sourceEventIds:events.map(e=>e.seq)};
      this.ledger.db.run("INSERT INTO settings(key,value) VALUES('local_invoice_sequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(next));
      this.ledger.db.run('INSERT INTO invoices(id,tenant,period,body) VALUES(?,?,?,?)',invoice.id,companyId,period,canonical(invoice));
      for(const e of events) this.ledger.db.run('INSERT INTO invoice_events(event,invoice) VALUES(?,?)',e.seq,invoice.id);
      this.ledger.db.append(companyId,'local_invoice_closed',null,this.ledger.now(),{invoiceId:invoice.id,totalCents:invoice.totalCents,digest:digest(invoice)});
      return invoice;
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
    const mode=provider==='local-simulation'?'local':provider==='square-sandbox'?'sandbox':provider==='square-live'?'live':'unknown';
    return {mode,invoiceId,receiptId:`receipt-${invoiceId}`,currency:'AUD',amountCents:p.amountCents,refundedCents:refunded.toString(),settledAt:p.settledAt};
  }
  /** Operator-only, explicit local refund of an existing unapplied, whole-cent credit.
   * Reserving its disposition prevents both an invoice credit and a cash refund. An
   * uncertain refund is held for reconciliation and never automatically replayed. */
  async refundLocalCredit(companyId:string,creditEventId:number,refundId:string) {
    id(refundId); integer(creditEventId,Number.MAX_SAFE_INTEGER); requireThat(this.payment,'payment_provider_unselected',503);
    const intent=this.ledger.db.transaction(()=>{
      const old=this.ledger.db.get('SELECT id FROM refund_intents WHERE id=? OR credit_event=?',refundId,creditEventId);
      requireThat(!old,'refund_reconciliation_required',409);
      const credit=this.ledger.db.get<EventRow>("SELECT seq,kind,request,body FROM events WHERE seq=? AND tenant=? AND kind='credit'",creditEventId,companyId);
      requireThat(credit,'credit_not_found',404); requireThat(!this.ledger.db.get('SELECT event FROM statement_events WHERE event=?',creditEventId),'credit_already_stated',409); requireThat(!this.ledger.db.get('SELECT event FROM invoice_events WHERE event=?',creditEventId),'credit_already_applied',409);
      const source=this.ledger.db.get<{invoice:string}>("SELECT i.invoice FROM invoice_events i JOIN events e ON e.seq=i.event WHERE e.request=? AND e.kind='usage_settled'",credit.request);
      requireThat(source,'credit_not_invoiced',409);
      const payment=this.ledger.db.get<{id:string;body:string}>('SELECT id,body FROM payments WHERE invoice=?',source.invoice); requireThat(payment,'payment_not_settled',409);
      const paid:VerifiedPayment=JSON.parse(payment.body); const amount=nano(JSON.parse(credit.body).amountNanoAud);
      requireThat(amount%10_000_000n===0n,'refund_requires_whole_cent_credit',409);
      const amountCents=(amount/10_000_000n).toString(); const held=this.ledger.db.all<{body:string}>('SELECT body FROM refund_intents WHERE payment=?',payment.id).reduce((sum,r)=>sum+BigInt(JSON.parse(r.body).amountCents),0n);
      requireThat(held+BigInt(amountCents)<=BigInt(paid.amountCents),'refund_exceeds_payment',409);
      const request:RefundRequest={refundId,transactionId:paid.transactionId,amountCents,currency:'AUD',idempotencyKey:`refund:${refundId}`};
      this.ledger.db.run('INSERT INTO refund_intents(id,tenant,payment,credit_event,body) VALUES(?,?,?,?,?)',refundId,companyId,payment.id,creditEventId,canonical(request));
      this.ledger.db.append(companyId,'refund_requested',credit.request,this.ledger.now(),{refundId,creditEventId,amountCents}); return request;
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
