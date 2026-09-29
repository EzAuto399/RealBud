import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { careTermsDraft, fixture } from './testing.ts';
import { BillingService, effectiveDueAt, invoiceStanding, type HostedPaymentAdapter, type Invoice, type VerifiedPayment } from './billing.ts';
import { closeList, closeMonth, operatorInvoice, operatorInvoices, recordManualPayment, reverseManualPayment } from './operator-billing.ts';
import { composeCareCollection, composePaymentInstructions } from './composition.ts';
import { invoiceHtml } from './invoice-html.ts';
import { OPERATOR_ROLE } from './operator-token.ts';

const cleanups:(()=>void)[]=[];afterEach(()=>{while(cleanups.length)cleanups.pop()!();});
const INTERNAL='realbud-internal', DAY=86_400_000;
const OPERATOR={subject:'operator:ops@realbud.example',role:OPERATOR_ROLE} as const;
const ISSUE=Date.parse('2026-10-01T00:00:00Z');
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

/** A Square stand-in: settles only what the test hands it. */
function stubAdapter(f:ReturnType<typeof fixture>) {
  let settle:VerifiedPayment|null=null;
  const adapter:HostedPaymentAdapter={id:'square-sandbox',mode:'sandbox',
    async createCheckout(request){return {sessionId:`order-${request.attemptId}`,url:'https://connect.squareupsandbox.com/checkout/one',expiresAt:f.now()+60_000};},
    async verifyWebhook(){return settle;},async requestRefund(){},async verifyRefundWebhook(){return null;}};
  return {adapter,settle:(p:VerifiedPayment)=>{settle=p;}};
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
    dueAt:ISSUE+7*DAY,status:'part_paid',overdue:true,paidCents:'2500',outstandingCents:'10000'}]);
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
