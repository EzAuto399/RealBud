import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { careTermsDraft, fixture } from './testing.ts';
import { BillingService, effectiveDueAt, invoiceStanding, type HostedPaymentAdapter, type Invoice, type VerifiedPayment, type VerifiedRefund } from './billing.ts';
import { closeList, closeMonth, operatorInvoice, operatorInvoices, recordManualPayment, reverseManualPayment } from './operator-billing.ts';
import { composeCareCollection, composePaymentInstructions } from './composition.ts';
import { invoiceHtml } from './invoice-html.ts';
import { OPERATOR_ROLE } from './operator-token.ts';
import { bindOfficeCustomer } from './provisioning.ts';
import { latestResaleAcceptance } from './commercial-terms.ts';
import { modelviaKeyClient } from './modelvia-keys.ts';
import { syncOfficeResalePolicy } from './office-ai-terms.ts';

const cleanups:(()=>void)[]=[];afterEach(()=>{while(cleanups.length)cleanups.pop()!();});
const INTERNAL='realbud-internal', DAY=86_400_000;
const OPERATOR={subject:'operator:ops@realbud.example',role:OPERATOR_ROLE} as const;
const ISSUE=Date.parse('2026-10-01T00:00:00Z');
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

/** A Square stand-in: settles only what the test hands it. */
function stubAdapter(f:ReturnType<typeof fixture>) {
  let settle:VerifiedPayment|null=null,refund:VerifiedRefund|null=null;
  const adapter:HostedPaymentAdapter={id:'square-sandbox',mode:'sandbox',
    async createCheckout(request){return {sessionId:`order-${request.attemptId}`,url:'https://connect.squareupsandbox.com/checkout/one',expiresAt:f.now()+60_000};},
    async verifyWebhook(){return settle;},async requestRefund(){},async verifyRefundWebhook(){return refund;}};
  return {adapter,settle:(p:VerifiedPayment)=>{settle=p;},refund:(r:VerifiedRefund)=>{refund=r;}};
}
function closed(options:{careCents?:string;adapter?:boolean;termsDays?:number}={}) {
  const f=fixture();cleanups.push(f.close);f.setTime(ISSUE);
  const stub=stubAdapter(f);
  const billing=options.adapter
    ?new BillingService(f.ledger,stub.adapter,{authorizeCollection:true,internalCompanyId:INTERNAL,...(options.termsDays!==undefined?{invoiceTermsDays:options.termsDays}:{})})
    :new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL,...(options.termsDays!==undefined?{invoiceTermsDays:options.termsDays}:{})});
  const published=billing.commercialTerms!.publish(careTermsDraft(f,'care-v1',options.careCents??'12500'));
  billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1');
  return {f,billing,invoice,stub};
}
const pay=(n:number,amountCents:string|number,extra:Record<string,unknown>={})=>({paymentId:uuid(n),method:'bank_transfer',amountCents,receivedOn:'2026-10-01',...extra});

test('an invoice is due REALBUD_INVOICE_TERMS_DAYS after issue (default 7); a legacy due-on-receipt invoice keeps its recorded date; an undated one reads as issue + terms',()=>{
  const {f,billing,invoice}=closed();
  assert.equal(billing.invoiceTermsDays,7);assert.equal(invoice.dueAt,ISSUE+7*DAY);
  assert.equal(closed({termsDays:14}).invoice.dueAt,ISSUE+14*DAY);
  assert.throws(()=>new BillingService(f.ledger,undefined,{invoiceTermsDays:-1}),/invalid_invoice_terms_days/);
  assert.throws(()=>new BillingService(f.ledger,undefined,{invoiceTermsDays:1.5}),/invalid_invoice_terms_days/);
  const legacy:Invoice={...invoice,dueAt:invoice.issuedAt};
  assert.equal(effectiveDueAt(legacy,7),ISSUE);
  const undated:Invoice={...invoice};delete undated.dueAt;
  assert.equal(effectiveDueAt(undated,7),ISSUE+7*DAY);
  // Configuration: default, explicit, and a malformed value refused by name.
  const env={REALBUD_INTERNAL_COMPANY_ID:INTERNAL};
  const never=async()=>{throw new Error('no network');};
  assert.equal(composeCareCollection({env,ledger:f.ledger,fetch:never}).billing.invoiceTermsDays,7);
  assert.equal(composeCareCollection({env:{...env,REALBUD_INVOICE_TERMS_DAYS:'30'},ledger:f.ledger,fetch:never}).billing.invoiceTermsDays,30);
  for(const bad of ['-1','7.5','seven','366']) assert.throws(()=>composeCareCollection({env:{...env,REALBUD_INVOICE_TERMS_DAYS:bad},ledger:f.ledger,fetch:never}),/care_collection_unconfigured:REALBUD_INVOICE_TERMS_DAYS/,bad);
});

test('status and overdue: unpaid, part paid with the balance, paid; overdue only after the due date and never once paid',()=>{
  const {f,billing,invoice}=closed();
  const standing=()=>invoiceStanding(f.ledger,invoice,f.now(),7);
  assert.deepEqual(standing(),{dueAt:ISSUE+7*DAY,paidCents:'0',outstandingCents:'12500',status:'unpaid',overdue:false,daysOverdue:0});
  f.setTime(ISSUE+7*DAY);assert.equal(standing().overdue,false);
  f.setTime(ISSUE+7*DAY+1);assert.deepEqual([standing().overdue,standing().daysOverdue],[true,0]);
  f.setTime(ISSUE+10*DAY+5);assert.deepEqual([standing().overdue,standing().daysOverdue],[true,3]);
  const part=recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'5000',{reference:'BANK-REF-1'}));
  assert.deepEqual([part.status,part.paidCents,part.outstandingCents,part.overdue,part.daysOverdue],['part_paid','5000','7500',true,3]);
  const full=recordManualPayment(billing,OPERATOR,invoice.id,pay(2,7500,{method:'payid'}));
  assert.deepEqual([full.status,full.paidCents,full.outstandingCents,full.overdue,full.daysOverdue],['paid','12500','0',false,0]);
  assert.deepEqual(full.payments.map(p=>[p.method,p.amountCents,p.reference,p.recordedBy,p.reversed]),[['bank_transfer','5000','BANK-REF-1',OPERATOR.subject,null],['payid','7500',null,OPERATOR.subject,null]]);
  assert.deepEqual([full.officeName,full.billingEmail,full.companyId,full.period,full.kind,full.totalCents,full.gstCents],[f.tenant.customerName,null,f.tenant.companyId,'2026-09','Tax Invoice','12500','1136']);
  // Fully paid: nothing more can be recorded.
  assert.throws(()=>recordManualPayment(billing,OPERATOR,invoice.id,pay(3,'1')),/payment_exceeds_outstanding/);
  f.db.verify();
});

test('record payment refuses bad input by code, a future receipt date and an amount over the outstanding balance',()=>{
  const {f,billing,invoice}=closed();
  const cases:[Record<string,unknown>,RegExp][]=[
    [{...pay(1,'100'),paymentId:'not-a-uuid'},/invalid_payment_id/],
    [pay(1,'100',{method:'cash'}),/invalid_payment_method/],
    [pay(1,'0'),/invalid_amount/],[pay(1,'-5'),/invalid_amount/],[pay(1,'10.50'),/invalid_amount/],[pay(1,1.5),/invalid_amount/],
    [pay(1,'100',{receivedOn:'2026-10-02'}),/invalid_received_on/],
    [pay(1,'100',{receivedOn:'2026-02-30'}),/invalid_received_on/],[pay(1,'100',{receivedOn:'01/10/2026'}),/invalid_received_on/],
    [pay(1,'100',{reference:'x'.repeat(121)}),/invalid_reference/],[pay(1,'100',{reference:'a\u0007b'}),/invalid_reference/],
    [pay(1,'100',{note:'x'.repeat(501)}),/invalid_note/],[pay(1,'100',{note:7}),/invalid_note/],
    [pay(1,'100',{recordedBy:'someone-else'}),/invalid_fields/],
    [pay(1,'12501'),/payment_exceeds_outstanding/],
  ];
  for(const [body,error] of cases) assert.throws(()=>recordManualPayment(billing,OPERATOR,invoice.id,body),error,JSON.stringify(body));
  assert.throws(()=>recordManualPayment(billing,OPERATOR,'RB-999999',pay(1,'100')),/invoice_not_found/);
  // Brisbane's date: 1 October 23:00 UTC is already 2 October in Brisbane.
  f.setTime(Date.parse('2026-10-01T23:00:00Z'));
  assert.equal(recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'100',{receivedOn:'2026-10-02',note:'Line one\nLine two'})).payments[0].receivedOn,'2026-10-02');
  assert.equal(f.db.all('SELECT id FROM manual_payments').length,1);
});

test('the same record twice is idempotent on its payment id; a different record under that id is a conflict',()=>{
  const {f,billing,invoice}=closed();
  const first=recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'5000',{reference:'REF'}));
  f.setTime(ISSUE+DAY);
  const again=recordManualPayment(billing,{...OPERATOR,subject:'operator:other@realbud.example'},invoice.id,pay(1,5000,{reference:'REF'}));
  assert.deepEqual(again.payments,first.payments);
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind='manual_payment_recorded'").length,1);
  for(const changed of [pay(1,'5001',{reference:'REF'}),pay(1,'5000',{reference:'OTHER'}),pay(1,'5000',{reference:'REF',method:'payid'}),pay(1,'5000',{reference:'REF',receivedOn:'2026-09-30'})])
    assert.throws(()=>recordManualPayment(billing,OPERATOR,invoice.id,changed),/payment_conflict/);
  // Replaying the record after the balance is settled still answers the invoice.
  recordManualPayment(billing,OPERATOR,invoice.id,pay(2,'7500'));
  assert.equal(recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'5000',{reference:'REF'})).status,'paid');
});

test('undo appends a reversal with a reason, deletes nothing, restores the balance and is idempotent',()=>{
  const {f,billing,invoice}=closed();
  recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'12500'));
  for(const reason of ['no','x'.repeat(301),'bad\u0000reason',5]) assert.throws(()=>reverseManualPayment(billing,OPERATOR,invoice.id,uuid(1),{reason}),/invalid_reason/);
  assert.throws(()=>reverseManualPayment(billing,OPERATOR,invoice.id,uuid(9),{reason:'Bounced payment'}),/payment_not_found/);
  assert.throws(()=>reverseManualPayment(billing,OPERATOR,invoice.id,uuid(1),{reason:'Bounced',extra:true}),/invalid_fields/);
  const undone=reverseManualPayment(billing,OPERATOR,invoice.id,uuid(1),{reason:'  Payment bounced  '});
  assert.deepEqual([undone.status,undone.paidCents,undone.outstandingCents],['unpaid','0','12500']);
  assert.deepEqual(undone.payments[0].reversed,{reason:'Payment bounced',by:OPERATOR.subject,at:ISSUE});
  assert.deepEqual(reverseManualPayment(billing,OPERATOR,invoice.id,uuid(1),{reason:'Payment bounced'}),undone);
  assert.throws(()=>reverseManualPayment(billing,OPERATOR,invoice.id,uuid(1),{reason:'Recorded by mistake'}),/reversal_conflict/);
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind='manual_payment_reversed'").length,1);
  // Append-only: neither the record nor its reversal can change or disappear.
  for(const sql of ["UPDATE manual_payments SET body='{}'",'DELETE FROM manual_payments',"UPDATE manual_payment_reversals SET body='{}'",'DELETE FROM manual_payment_reversals'])
    assert.throws(()=>f.db.run(sql),/immutable_record/,sql);
  // Replaying the undone record does not revive it; a new record needs a new id.
  assert.equal(recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'12500')).status,'unpaid');
  assert.throws(()=>recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'12000')),/payment_conflict/);
  assert.equal(recordManualPayment(billing,OPERATOR,invoice.id,pay(2,'12500')).status,'paid');
  f.db.verify();
});

test('card and transfer: a settled card payment refuses a transfer record and cannot be undone here; a card settling after a transfer is kept and shows overpaid; checkout waits for the transfer balance',async()=>{
  // Card first.
  {
    const {f,billing,invoice,stub}=closed({adapter:true});
    const session=await billing.checkout(f.owner,invoice.id);
    const attemptId=JSON.parse(f.db.get<{body:string}>('SELECT body FROM checkouts WHERE invoice=?',invoice.id)!.body).attemptId;
    stub.settle({eventId:'event-card',transactionId:'transaction-card',invoiceId:invoice.id,attemptId,sessionId:session.sessionId,amountCents:'12500',currency:'AUD',settledAt:f.now()});
    await billing.webhook(Buffer.from('{}'),'sig');
    const paid=operatorInvoice(billing,invoice);
    assert.deepEqual([paid.status,paid.paidCents],['paid','12500']);
    assert.deepEqual(paid.payments,[{id:'square-sandbox:transaction-card',method:'square',amountCents:'12500',receivedOn:'2026-10-01',reference:'transaction-card',note:null,recordedBy:null,recordedAt:ISSUE,reversed:null}]);
    assert.throws(()=>recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'100')),/invoice_already_paid/);
    assert.throws(()=>reverseManualPayment(billing,OPERATOR,invoice.id,'square-sandbox:transaction-card',{reason:'Wrong invoice'}),/square_payment_not_reversible/);
  }
  // Transfer first, then a checkout already opened before it settles by card.
  {
    const {f,billing,invoice,stub}=closed({adapter:true});
    const session=await billing.checkout(f.owner,invoice.id);
    recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'5000'));
    await assert.rejects(billing.checkout(f.owner,invoice.id),/balance_payable_by_transfer/);
    const attemptId=JSON.parse(f.db.get<{body:string}>('SELECT body FROM checkouts WHERE invoice=?',invoice.id)!.body).attemptId;
    stub.settle({eventId:'event-card',transactionId:'transaction-card',invoiceId:invoice.id,attemptId,sessionId:session.sessionId,amountCents:'12500',currency:'AUD',settledAt:f.now()});
    assert.deepEqual(await billing.webhook(Buffer.from('{}'),'sig'),{duplicate:false});
    const both=operatorInvoice(billing,invoice);
    assert.deepEqual([both.status,both.paidCents,both.outstandingCents,both.payments.map(p=>p.method)],['overpaid','17500','0',['square','bank_transfer']]);
    const squareReceipt=billing.receipt(f.owner,invoice.id);assert.equal(squareReceipt.mode,'sandbox');assert.equal(squareReceipt.amountCents,'12500');
    assert.equal(billing.portalInvoices(f.owner)[0].paid,true);assert.equal(billing.portalInvoices(f.owner)[0].receiptKind,'square');
    reverseManualPayment(billing,OPERATOR,invoice.id,uuid(1),{reason:'Fictional transfer recorded incorrectly'});
    billing.creditCare(f.tenant.companyId,invoice.id,'synthetic-refund-credit','5000','synthetic-goodwill');
    const credit=f.db.get<{seq:number}>("SELECT seq FROM events WHERE kind='care_credit'")!.seq;
    await billing.refundCareCredit(f.tenant.companyId,credit,'synthetic-refund');
    stub.refund({eventId:'synthetic-refund-event',refundId:'synthetic-refund',providerRefundId:'provider-synthetic-refund',transactionId:'transaction-card',amountCents:'5000',currency:'AUD',settledAt:f.now()});
    await billing.refundWebhook(Buffer.from('{}'),'sig');
    const refunded=billing.receipt(f.owner,invoice.id);assert.equal(refunded.mode,'sandbox');
    if(String(refunded.mode)==='operator_recorded')assert.fail('Square source required');
    assert.deepEqual([refunded.amountCents,refunded.refundedCents],['12500','5000']);
    const standing=billing.portalInvoices(f.owner)[0];assert.deepEqual([standing.paid,standing.status,standing.paidCents,standing.outstandingCents],[true,'paid','12500','0']);
    assert.notEqual(operatorInvoice(billing,invoice).payments.find(p=>p.method==='bank_transfer')!.reversed,null);

  }
  // A reversed transfer no longer blocks card checkout.
  {
    const {f,billing,invoice}=closed({adapter:true});
    recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'5000'));
    await assert.rejects(billing.checkout(f.owner,invoice.id),/balance_payable_by_transfer/);
    reverseManualPayment(billing,OPERATOR,invoice.id,uuid(1),{reason:'Recorded against the wrong office'});
    assert.match((await billing.checkout(f.owner,invoice.id)).url,/^https:/);
  }
});

test('zero and credit invoices: nothing due or credit, and no payment action',()=>{
  const zero=closed({careCents:'0'});
  assert.deepEqual([zero.invoice.totalCents,operatorInvoice(zero.billing,zero.invoice).status],['0','nothing_due']);
  assert.throws(()=>recordManualPayment(zero.billing,OPERATOR,zero.invoice.id,pay(1,'1')),/nothing_to_pay/);
  const {f,billing,invoice}=closed();
  billing.creditCare(f.tenant.companyId,invoice.id,'credit-all','12500','synthetic-goodwill');
  f.setTime(Date.parse('2026-11-01T00:00:00Z'));
  const october=billing.commercialTerms!.publish(careTermsDraft(f,'care-oct','0',{period:'2026-10'}));billing.commercialTerms!.accept(f.owner,'2026-10','care-oct',october.digest);
  const note=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-10','care-oct');
  assert.equal(note.kind,'Adjustment Note');
  const view=operatorInvoice(billing,note);
  assert.deepEqual([view.status,view.outstandingCents,view.overdue],['credit','0',false]);
  f.setTime(Date.parse('2026-12-01T00:00:00Z'));assert.equal(operatorInvoice(billing,note).overdue,false);
  assert.throws(()=>recordManualPayment(billing,OPERATOR,note.id,pay(1,'1')),/nothing_to_pay/);
  // The list is newest first.
  assert.deepEqual(operatorInvoices(billing).invoices.map(i=>i.id),[note.id,invoice.id]);
});

test('portal invoices add due date, status, overdue, paid and outstanding; the paid flag stays the Square settlement',()=>{
  const {f,billing,invoice}=closed();
  recordManualPayment(billing,OPERATOR,invoice.id,pay(1,'2500'));
  f.setTime(ISSUE+9*DAY);
  assert.deepEqual(billing.portalInvoices(f.owner),[{id:invoice.id,kind:'Tax Invoice',period:'2026-09',currency:'AUD',gstInclusive:true,totalCents:'12500',gstCents:'1136',paid:false,aiUsageCsv:false,
    dueAt:ISSUE+7*DAY,status:'part_paid',overdue:true,paidCents:'2500',outstandingCents:'10000',receiptKind:'recorded'}]);
  assert.deepEqual(billing.portalInvoices({...f.owner,companyId:'company-other'}),[]);
});

test('month close from the desk: offices with terms listed as closed, ready or blocked with the reason; close resolves the accepted version and is idempotent',async()=>{
  const f=fixture();cleanups.push(f.close);f.setTime(Date.parse('2026-10-05T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  const other={...f.tenant,companyId:'company-b',licenseId:'license-b',customerName:'Fictional Agency B'};f.ledger.provisionTenant(other);
  const third={...f.tenant,companyId:'company-c',licenseId:'license-c',customerName:'Fictional Agency C'};f.ledger.provisionTenant(third);
  f.ledger.provisionTenant({...f.tenant,companyId:'company-none',licenseId:'license-none'});
  // A: accepted. B: published, never accepted. C: accepted v1, then v2 published and not accepted.
  const a=billing.commercialTerms!.publish(careTermsDraft(f,'care-a1','12500',{customer:{name:f.tenant.customerName,address:f.tenant.customerAddress,tradingName:'Agency A Realty'}}));
  billing.commercialTerms!.accept(f.owner,'2026-09','care-a1',a.digest);
  billing.commercialTerms!.publish(careTermsDraft({tenant:other},'care-b1','9900'));
  const c1=billing.commercialTerms!.publish(careTermsDraft({tenant:third},'care-c1','9900'));
  billing.commercialTerms!.accept({...f.owner,companyId:'company-c'},'2026-09','care-c1',c1.digest);
  billing.commercialTerms!.publish(careTermsDraft({tenant:third},'care-c2','8800'));
  const list=closeList(billing,'2026-09');
  assert.deepEqual(list,{period:'2026-09',offices:[
    {companyId:'company-a',officeName:'Agency A Realty',invoiceId:null,termsVersion:'care-a1',state:'ready',blocker:null},
    {companyId:'company-b',officeName:'Fictional Agency B',invoiceId:null,termsVersion:null,state:'blocked',blocker:'terms_not_accepted'},
    {companyId:'company-c',officeName:'Fictional Agency C',invoiceId:null,termsVersion:null,state:'blocked',blocker:'terms_version_ambiguous'}]});
  assert.throws(()=>closeList(billing,'2026-13'),/invalid_billing_period/);
  // The current month is not closed yet.
  assert.equal(closeList(billing,'2026-10').offices[0].blocker,'terms_not_accepted');
  const now=billing.commercialTerms!.publish(careTermsDraft(f,'care-a-oct','12500',{period:'2026-10'}));billing.commercialTerms!.accept(f.owner,'2026-10','care-a-oct',now.digest);
  assert.deepEqual(closeList(billing,'2026-10').offices[0],{companyId:'company-a',officeName:f.tenant.customerName,invoiceId:null,termsVersion:'care-a-oct',state:'blocked',blocker:'month_not_closed'});

  const options={billing,clientFundedCompanies:new Set<string>()};
  await assert.rejects(closeMonth(options,OPERATOR,{companyId:'company-b',period:'2026-09'}),/terms_not_accepted/);
  await assert.rejects(closeMonth(options,OPERATOR,{companyId:'company-c',period:'2026-09'}),/terms_version_ambiguous/);
  await assert.rejects(closeMonth(options,OPERATOR,{companyId:'company-a',period:'2026-09',termsVersion:'care-a1'}),/invalid_fields/);
  await assert.rejects(closeMonth(options,OPERATOR,{companyId:'company-a',period:'2026-09',deferAi:'yes'}),/invalid_defer_ai/);
  await assert.rejects(closeMonth({...options,policyUnavailable:'provisioning_unconfigured:REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES'},OPERATOR,{companyId:'company-a',period:'2026-09'}),/provisioning_unconfigured:REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES/);
  const first=await closeMonth(options,OPERATOR,{companyId:'company-a',period:'2026-09',deferAi:false});
  assert.deepEqual([first.ai,first.alreadyClosed,first.invoice.status,first.invoice.dueAt,first.invoice.officeName,first.invoice.totalCents],['care_only',false,'unpaid',f.now()+7*DAY,'Agency A Realty','12500']);
  const again=await closeMonth(options,OPERATOR,{companyId:'company-a',period:'2026-09'});
  assert.deepEqual([again.invoice.id,again.ai,again.alreadyClosed],[first.invoice.id,'already_closed',true]);
  assert.deepEqual(closeList(billing,'2026-09').offices[0],{companyId:'company-a',officeName:'Agency A Realty',invoiceId:first.invoice.id,termsVersion:'care-a1',state:'closed',blocker:null});
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind='operator_month_closed'").length,1);
  f.db.verify();
});

test('the operator close wrapper holds default AI for missing, pending or failed policy proof; deferAi defers only a month Modelvia has not invoiced, and never a finalized invoice',async()=>{
  for(const state of ['missing','pending','failed'] as const) {
    const f=fixture();cleanups.push(f.close);f.setTime(ISSUE);
    const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
    const published=billing.commercialTerms!.publish(careTermsDraft(f,'resale-v1','12500',{aiUsage:{billing:'resale',markupBasisPoints:3000,termsReference:'synthetic-agreed-resale'}}));
    billing.commercialTerms!.accept(f.owner,'2026-09','resale-v1',published.digest);bindOfficeCustomer(f.ledger,'company-a','synthetic-office-customer');
    if(state!=='missing') {
      const accepted=latestResaleAcceptance(f.ledger,'company-a')!;const providerNow=Date.parse('2026-09-20T00:00:00Z');
      const sdk=modelviaKeyClient({serviceOrigin:'https://synthetic.modelvia.invalid',environment:'production',clientId:'realbud',allowedModels:['synthetic'],scopedSecret:()=> 'synthetic-only-operator-secret-at-least-32',operatorSubject:'synthetic',now:()=>providerNow,
        fetch:async(url,init)=>{
          if(state==='failed') throw new Error('synthetic_provider_unavailable');
          assert.equal(init.method,'GET','pending proof is read, never a policy rewrite');
          const path=new URL(url).pathname;const json=(body:unknown)=>Response.json(body,{headers:{date:new Date(providerNow).toUTCString()}});
          if(path==='/v1/operator/customers')return json({accounts:[{id:'synthetic-office-customer',clientId:'realbud',name:'Fictional office',active:true,version:1,payer:'client',monthlyCapNanoAud:'200000000000',maxConcurrent:2,allowedModels:['synthetic']}]});
          if(path==='/v1/operator/clients')return json({accounts:[{id:'realbud',billingMode:'client'}]});
          if(path==='/v1/operator/commercial-policies')return json({policies:[{id:'synthetic-pending-policy',clientId:'realbud',customerId:'synthetic-office-customer',state:'active',customerBilling:'resale',clientMarkupBasisPoints:3000,acceptanceReference:accepted.acceptanceReference,effectiveAt:providerNow+1}]});
          throw new Error('unexpected_synthetic_policy_route');
        }});
      assert.equal((await syncOfficeResalePolicy({ledger:f.ledger,modelvia:sdk,clientFundedCompanies:new Set()},'company-a')).state,state);
    }
    // Modelvia has usage for September but no invoice yet; one finalized invoice
    // can be switched on to prove it is never deferred.
    let reads=0,finalized=false;
    const summary={id:'CI-00000777',period:'2026-09',totalCents:'1300',gstCents:'118'};
    const modelvia={async customerMonth(){reads++;return {invoices:finalized?[summary]:[],customerCheckout:'off' as const,usageExpected:true};},async customerInvoice():Promise<never>{reads++;throw new Error('synthetic_invoice_not_read');},async customerMargins():Promise<never>{reads++;throw new Error('synthetic_margins_not_read');}};
    const options={billing,modelvia,clientFundedCompanies:new Set<string>()};
    const blocker={missing:'ai_policy_not_synced',pending:'ai_policy_pending',failed:'ai_policy_sync_failed'}[state];
    assert.equal(closeList(billing,'2026-09').offices[0].blocker,blocker);
    await assert.rejects(closeMonth(options,OPERATOR,{companyId:'company-a',period:'2026-09',expectedTermsVersion:'resale-v1'}),error=>error instanceof Error && error.message===blocker);
    assert.equal(reads,0);assert.equal(f.db.all('SELECT id FROM invoices').length,0);
    finalized=true;
    await assert.rejects(closeMonth(options,OPERATOR,{companyId:'company-a',period:'2026-09',expectedTermsVersion:'resale-v1',deferAi:true}),error=>error instanceof Error && error.message===blocker);
    assert.equal(f.db.all('SELECT id FROM invoices').length,0);
    finalized=false;
    const closed=await closeMonth(options,OPERATOR,{companyId:'company-a',period:'2026-09',expectedTermsVersion:'resale-v1',deferAi:true});
    assert.ok(reads>0);assert.deepEqual([closed.ai,closed.invoice.totalCents,closed.alreadyClosed],['deferred','12500',false]);
    const invoice=billing.invoice(f.owner,closed.invoice.id);assert.deepEqual(invoice.aiUsage!.modelviaInvoices,[]);assert.deepEqual(invoice.aiUsage!.deferredPeriods,['2026-09']);
    const replay=await closeMonth(options,OPERATOR,{companyId:'company-a',period:'2026-09',expectedTermsVersion:'resale-v1',deferAi:true});
    assert.equal(replay.invoice.id,closed.invoice.id);assert.equal(replay.alreadyClosed,true);assert.equal(f.db.all("SELECT seq FROM events WHERE kind='ai_usage_deferred'").length,1);
  }
});

test('explicit operator care-only still requires genuine latest acceptance, reviewed version, configuration and the office own customer binding',async()=>{
  const f=fixture();cleanups.push(f.close);f.setTime(ISSUE);const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  const draft=(version:string)=>careTermsDraft(f,version,'12500',{aiUsage:{billing:'resale' as const,markupBasisPoints:3000,termsReference:'synthetic-agreed-resale'}});
  const one=billing.commercialTerms!.publish(draft('resale-v1'));const options={billing,clientFundedCompanies:new Set<string>()};
  const input={companyId:'company-a',period:'2026-09',expectedTermsVersion:'resale-v1',deferAi:true};
  await assert.rejects(closeMonth(options,OPERATOR,input),/terms_not_accepted/);
  billing.commercialTerms!.accept(f.owner,'2026-09','resale-v1',one.digest);
  const two=billing.commercialTerms!.publish(draft('resale-v2'));
  await assert.rejects(closeMonth(options,OPERATOR,input),/terms_version_ambiguous/);
  billing.commercialTerms!.accept(f.owner,'2026-09','resale-v2',two.digest);
  await assert.rejects(closeMonth(options,OPERATOR,input),/commercial_terms_changed/);
  const reviewed={...input,expectedTermsVersion:'resale-v2'};
  await assert.rejects(closeMonth({...options,policyUnavailable:'provisioning_unconfigured:REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES'},OPERATOR,reviewed),/provisioning_unconfigured/);
  bindOfficeCustomer(f.ledger,'company-other','synthetic-foreign-customer');
  assert.throws(()=>bindOfficeCustomer(f.ledger,'company-a','synthetic-foreign-customer'),/modelvia_customer_bound_elsewhere/);
  await assert.rejects(closeMonth(options,OPERATOR,reviewed),/office_modelvia_customer_unbound/);
  assert.equal(f.db.all('SELECT id FROM invoices').length,0);assert.equal(f.db.all("SELECT seq FROM events WHERE kind='ai_usage_deferred'").length,0);
});

test('the invoice document prints the due date and, for a payable invoice, how to pay with the invoice number as reference',()=>{
  const {invoice}=closed();
  const instructions=composePaymentInstructions({REALBUD_PAYID:'0455123764',REALBUD_PAYID_NAME:'Fictional RealBud Pty Ltd',REALBUD_BANK_ACCOUNT_NAME:'Fictional RealBud Pty Ltd',REALBUD_BANK_BSB:'064 000',REALBUD_BANK_ACCOUNT_NUMBER:'1234 5678'});
  assert.deepEqual(instructions,{payId:{id:'0455123764',name:'Fictional RealBud Pty Ltd'},bank:{accountName:'Fictional RealBud Pty Ltd',bsb:'064-000',accountNumber:'12345678'}});
  const html=invoiceHtml(invoice,{paymentInstructions:instructions,card:true});
  for(const expected of ['Due 2026-10-08 (due in 7 days)','How to pay','PayID</b> 0455123764','BSB 064-000','Account 12345678','<b>Card</b>',`Use <b>${invoice.id}</b> as the payment reference`]) assert.ok(html.includes(expected),expected);
  assert.doesNotMatch(invoiceHtml(invoice,{paymentInstructions:{...instructions,bank:null}}),/Bank transfer|<b>Card<\/b>/);
  assert.doesNotMatch(invoiceHtml(invoice),/How to pay/);
  assert.match(invoiceHtml({...invoice,dueAt:invoice.issuedAt}),/Due 2026-10-01 \(on receipt\)/);
  // Nothing to pay on a zero invoice.
  const zero=closed({careCents:'0'});assert.doesNotMatch(invoiceHtml(zero.invoice,{paymentInstructions:instructions}),/How to pay/);
  // Escaped, and a half-configured account is never shown.
  assert.ok(invoiceHtml(invoice,{paymentInstructions:{payId:{id:'<b>',name:'x'},bank:null}}).includes('&lt;b&gt;'));
  assert.deepEqual(composePaymentInstructions({REALBUD_PAYID:'0455123764',REALBUD_BANK_ACCOUNT_NAME:'Name',REALBUD_BANK_BSB:'06400',REALBUD_BANK_ACCOUNT_NUMBER:'12345678'}),{payId:null,bank:null});
  assert.deepEqual(composePaymentInstructions({}),{payId:null,bank:null});
});

test('the invoice list runs no schema DDL after the first read and reads each invoice\'s payments once',()=>{
  const {f,billing}=closed();
  operatorInvoices(billing);
  const count=f.db.get<{n:number}>('SELECT count(*) AS n FROM invoices')!.n;
  let prepares=0, ddl=0;
  const prepare=f.db.sql.prepare.bind(f.db.sql), exec=f.db.sql.exec.bind(f.db.sql);
  f.db.sql.prepare=((...a:Parameters<typeof prepare>)=>{prepares++;return prepare(...a);}) as typeof prepare;
  f.db.sql.exec=((s:string)=>{ddl+=(s.match(/CREATE /g)??[]).length;return exec(s);}) as typeof exec;
  try { assert.equal(operatorInvoices(billing).invoices.length,count); }
  finally { f.db.sql.prepare=prepare; f.db.sql.exec=exec; }
  assert.equal(ddl,0);
  assert.ok(prepares<=2*count+1,`${prepares} queries for ${count} invoices`);
});

test('operator mutation snapshots reject another office and stale balances; same effect identity safely survives a lost reply',()=>{
 const {f,billing,invoice}=closed();
 const input=pay(70,'5000',{expectedCompanyId:f.tenant.companyId,expectedOutstandingCents:'12500'});
 assert.throws(()=>recordManualPayment(billing,OPERATOR,invoice.id,{...input,expectedCompanyId:'company-other'}),/account_changed/);
 recordManualPayment(billing,OPERATOR,invoice.id,input);
 assert.equal(recordManualPayment(billing,OPERATOR,invoice.id,input).paidCents,'5000');
 assert.throws(()=>recordManualPayment(billing,OPERATOR,invoice.id,pay(71,'100',{expectedCompanyId:f.tenant.companyId,expectedOutstandingCents:'12500'})),/invoice_changed/);
 assert.equal(f.db.all('SELECT id FROM manual_payments').length,1);
 assert.throws(()=>reverseManualPayment(billing,OPERATOR,invoice.id,uuid(70),{reason:'Recorded incorrectly',expectedCompanyId:'company-other',expectedOutstandingCents:'7500'}),/account_changed/);
 assert.throws(()=>reverseManualPayment(billing,OPERATOR,invoice.id,uuid(70),{reason:'Recorded incorrectly',expectedCompanyId:f.tenant.companyId,expectedOutstandingCents:'12500'}),/invoice_changed/);
 const reversal={reason:'Recorded incorrectly',expectedCompanyId:f.tenant.companyId,expectedOutstandingCents:'7500'};
 assert.equal(reverseManualPayment(billing,OPERATOR,invoice.id,uuid(70),reversal).outstandingCents,'12500');
 assert.equal(reverseManualPayment(billing,OPERATOR,invoice.id,uuid(70),reversal).outstandingCents,'12500');
 assert.equal(f.db.all('SELECT payment FROM manual_payment_reversals').length,1);f.db.verify();
});

test('portal transfer acknowledgment truth remains separate from Square paid proof and keeps partial/reversed audit records',()=>{
 const {f,billing,invoice}=closed();
 assert.throws(()=>billing.receipt(f.owner,invoice.id),/payment_not_settled/);
 recordManualPayment(billing,OPERATOR,invoice.id,pay(80,'5000',{reference:'BANK-80',note:'Private operator note'}));
 let row=billing.portalInvoices(f.owner)[0];assert.deepEqual([row.paid,row.status,row.paidCents,row.outstandingCents,row.receiptKind],[false,'part_paid','5000','7500','recorded']);
 let receipt=billing.receipt(f.owner,invoice.id);assert.equal(receipt.mode,'operator_recorded');assert.equal(receipt.amountCents,'5000');assert(!JSON.stringify(receipt).includes('Private operator note'));
 recordManualPayment(billing,OPERATOR,invoice.id,pay(81,'7500',{method:'payid'}));
 row=billing.portalInvoices(f.owner)[0];assert.deepEqual([row.paid,row.status,row.paidCents,row.outstandingCents],[false,'paid','12500','0']);
 reverseManualPayment(billing,OPERATOR,invoice.id,uuid(80),{reason:'Transfer bounced'});
 receipt=billing.receipt(f.owner,invoice.id);assert.equal(receipt.mode,'operator_recorded');
 if(receipt.mode!=='operator_recorded')assert.fail('manual source required');
 assert.equal(receipt.amountCents,'7500');assert.equal(receipt.outstandingCents,'5000');assert.equal(receipt.payments[0].reversedAt,ISSUE);
 assert.throws(()=>billing.receipt({...f.owner,companyId:'company-other'},invoice.id),/invoice_not_found/);f.db.verify();
});


test('operator care-only audit failure rolls back the invoice, deferral and outbox; retry records the initiating operator once',async()=>{
  const f=fixture();cleanups.push(f.close);f.setTime(ISSUE);
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  const published=billing.commercialTerms!.publish(careTermsDraft(f,'audit-care','12500',{
    customer:{name:f.tenant.customerName,address:f.tenant.customerAddress,billingEmail:'synthetic-billing@example.test'},
    aiUsage:{billing:'resale',markupBasisPoints:3000,termsReference:'synthetic-resale-terms'}}));
  billing.commercialTerms!.accept(f.owner,'2026-09','audit-care',published.digest);
  bindOfficeCustomer(f.ledger,f.tenant.companyId,'synthetic-audit-customer');
  let reads=0;
  const modelvia={async customerMonth(){reads++;return {invoices:[],customerCheckout:'off' as const,usageExpected:true};},async customerInvoice():Promise<never>{reads++;throw new Error('synthetic_provider_not_used');},async customerMargins():Promise<never>{throw new Error('synthetic_provider_not_used');}};
  const options={billing,modelvia,clientFundedCompanies:new Set<string>()},input={companyId:f.tenant.companyId,period:'2026-09',expectedTermsVersion:'audit-care',deferAi:true};
  const append=f.db.append.bind(f.db),sequence=f.db.get("SELECT value FROM settings WHERE key='local_invoice_sequence'");
  f.db.append=(tenant,kind,...args)=>{if(kind==='operator_month_closed'){assert.equal(f.db.sql.isTransaction,true);throw new Error('synthetic_operator_audit_fault');}return append(tenant,kind,...args);};
  try { await assert.rejects(closeMonth(options,OPERATOR,input),/synthetic_operator_audit_fault/); }
  finally { f.db.append=append; }
  assert.equal(reads,1);assert.equal(f.db.all('SELECT id FROM invoices').length,0);
  assert.equal(f.db.all('SELECT invoice FROM invoice_email_outbox').length,0);
  assert.equal(f.db.all('SELECT modelvia_invoice FROM office_ai_consolidations').length,0);
  assert.deepEqual(f.db.get("SELECT value FROM settings WHERE key='local_invoice_sequence'"),sequence);
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind IN ('operator_month_closed','ai_usage_deferred','ai_usage_consolidated','local_invoice_closed')").length,0);f.db.verify();
  const created=await closeMonth(options,OPERATOR,input);
  assert.equal(created.invoice.totalCents,'12500');assert.equal(created.ai,'deferred');assert.equal(reads,2);
  const original=f.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',created.invoice.id)!.body;
  const event=f.db.all<{body:string}>("SELECT body FROM events WHERE kind='operator_month_closed'");
  assert.equal(event.length,1);assert.equal(JSON.parse(event[0].body).by,OPERATOR.subject);
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind='ai_usage_deferred'").length,1);
  assert.equal(f.db.all('SELECT invoice FROM invoice_email_outbox').length,1);
  const repeated=await closeMonth(options,{...OPERATOR,subject:'operator:synthetic-other@example.test'},input);
  assert.equal(repeated.alreadyClosed,true);assert.equal(repeated.invoice.id,created.invoice.id);assert.equal(reads,2);
  assert.equal(f.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',created.invoice.id)!.body,original);
  assert.deepEqual(f.db.all("SELECT body FROM events WHERE kind='operator_month_closed'"),event);f.db.verify();
});

test('a recorded receipt is offered only while a recorded payment stands', () => {
  const f=fixture();cleanups.push(f.close);f.setTime(ISSUE);
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  const terms=billing.commercialTerms!.publish(careTermsDraft(f,'receipt-v1','12500'));billing.commercialTerms!.accept(f.owner,'2026-09','receipt-v1',terms.digest);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','receipt-v1');
  const kind=()=>billing.portalInvoices(f.owner)[0].receiptKind;
  assert.equal(kind(),null);
  recordManualPayment(billing,OPERATOR,invoice.id,{paymentId:'22222222-2222-4222-8222-222222222222',method:'bank_transfer',amountCents:'5000',receivedOn:'2026-10-01'});
  assert.equal(kind(),'recorded');
  reverseManualPayment(billing,OPERATOR,invoice.id,'22222222-2222-4222-8222-222222222222',{reason:'Bank returned the transfer'});
  assert.equal(kind(),null);
});
