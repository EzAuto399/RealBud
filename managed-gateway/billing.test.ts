import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { careTermsDraft, fixture } from './testing.ts';
import { BillingService, type HostedPaymentAdapter, type VerifiedPayment, type VerifiedRefund } from './billing.ts';
import { composeCareCollection } from './composition.ts';
import { invoiceHtml } from './invoice-html.ts';

const cleanups:(()=>void)[]=[];const setup=()=>{const f=fixture();cleanups.push(f.close);return f;};afterEach(()=>{while(cleanups.length)cleanups.pop()!();});
const INTERNAL='realbud-internal';
/** A month of AI activity in the ledger that a care invoice must never see: one
 * settled request, one AI credit against it and one request left unknown. */
async function aiActivity(f:ReturnType<typeof fixture>) {
  await f.run();
  f.ledger.credit(f.ledger.requests(f.tenant.companyId)[0].id,'ai-credit','10000000','synthetic-ai-correction');
  const r=f.ledger.reserve(f.grant(f.request,{jti:'grant-two',jobId:'job-two',attemptId:'attempt-two'}),'fixture-host-key','fp','idem-two',f.provider.bound(f.request)).record;
  f.ledger.dispatch(r.id,f.grant(f.request,{jti:'grant-two',jobId:'job-two',attemptId:'attempt-two'}),f.provider.id);f.ledger.unknown(r.id,'interrupted');
}
function accepted(f:ReturnType<typeof fixture>,billing:BillingService,version='care-v1',careCents='12500') {
  const published=billing.commercialTerms!.publish(careTermsDraft(f,version,careCents));
  billing.commercialTerms!.accept(f.owner,'2026-09',version,published.digest);
  return published;
}
/** A minimal adapter standing in for Square: records what it was asked, settles nothing by itself. */
function stubAdapter(f:ReturnType<typeof fixture>) {
  const refunds:string[]=[];
  let settle:VerifiedPayment|null=null, refund:VerifiedRefund|null=null;
  const adapter:HostedPaymentAdapter={id:'square-sandbox',mode:'sandbox',
    async createCheckout(request){return {sessionId:`order-${request.attemptId}`,url:'https://connect.squareupsandbox.com/checkout/one',expiresAt:f.now()+60_000};},
    async verifyWebhook(){return settle;},async requestRefund(request){refunds.push(request.refundId);},async verifyRefundWebhook(){return refund;}};
  return {adapter,refunds,settle:(p:VerifiedPayment)=>{settle=p;},refund:(r:VerifiedRefund)=>{refund=r;}};
}

test('a care invoice carries only the accepted care line: AI usage, AI credits and unreconciled requests in the ledger neither appear nor block it',async()=>{
  const f=setup();await aiActivity(f);f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind IN ('usage_settled','credit','usage_unknown')").length,3);
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  const published=accepted(f,billing);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1');
  assert.equal(invoice.id,'RB-000001');assert.equal(invoice.mode,'commercial');assert.equal(invoice.kind,'Tax Invoice');
  assert.deepEqual(invoice.lines.map(l=>[l.description,l.amountCents]),[['RealBud software and routine maintenance — monthly care','12500']]);
  assert.equal(invoice.totalCents,'12500');assert.equal(invoice.gstCents,'1136');
  assert.deepEqual(invoice.sourceEventIds,[]);
  assert.equal(invoice.supplier.legalName,'Fictional RealBud Seller');assert.equal(invoice.customer.name,f.tenant.customerName);
  assert.equal(invoice.careAgreementRef,'synthetic-care-agreement');assert.equal(invoice.commercialTerms?.digest,published.digest);
  const html=invoiceHtml(invoice);
  for(const forbidden of ['AI usage —','AI usage credit','Rate version','fixture-text','fixture-r1','Usage reference','LOCAL TEST DOCUMENT']) assert.doesNotMatch(html,new RegExp(forbidden),forbidden);
  assert.match(html,/Modelvia/);assert.match(html,/12 345 678 901/);
  // Usage events stay unbilled here for ever: they are Modelvia's, not this invoice's.
  assert.equal(f.db.all('SELECT * FROM invoice_events').length,0);
  assert.equal(billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1').id,invoice.id);
  assert.throws(()=>f.db.run("UPDATE invoices SET body='{}'"),/immutable_record/);
  f.db.verify();
});

test('terms with no rate card are accepted and closed; a zero-cap entitlement created by the operator command is a billable customer',()=>{
  const f=setup();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const goLiveAt=Date.parse('2026-06-01T00:00:00Z');
  const created=f.ledger.putEntitlement({companyId:'company-care',licenseId:'license-care',active:true,serviceExpiresAt:f.now()+86_400_000,customerName:'Fictional Agency Care',customerAddress:'2 Example Street, Brisbane QLD',customerAbn:'98765432109',goLiveAt,goLiveEvidence:'fixture-order'},'fixture-ticket');
  assert.equal(created.tenant.monthlyCapNanoAud,'0');
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  const draft=careTermsDraft({tenant:created.tenant},'care-v1','9900');
  assert.deepEqual(draft.rateCards,[]);
  const published=billing.commercialTerms!.publish(draft);
  const owner={...f.owner,companyId:'company-care'};
  billing.commercialTerms!.accept(owner,'2026-09','care-v1',published.digest);
  const invoice=billing.finalizeCommercialInvoice('company-care','2026-09','care-v1');
  assert.equal(invoice.totalCents,'9900');assert.equal(invoice.customer.abn,'98765432109');
  // A rate-card reference is shape-checked only and never looked up in the ledger.
  const referenced=billing.commercialTerms!.publish(careTermsDraft({tenant:created.tenant},'care-v2','9900',{period:'2026-08',rateCards:[{version:'modelvia-reference-only',digest:'a'.repeat(64)}]}));
  assert.equal(referenced.terms.rateCards.length,1);
  assert.throws(()=>billing.commercialTerms!.publish(careTermsDraft({tenant:created.tenant},'care-v3','9900',{period:'2026-07',rateCards:[{version:'x',digest:'not-hex'}]})),/commercial_rate_card_invalid/);
  f.db.verify();
});

test('close needs the month closed, the terms accepted, an outside billable company and a forward-moving sequence',()=>{
  const f=setup();
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  const published=billing.commercialTerms!.publish(careTermsDraft(f,'care-v1','12500'));
  assert.throws(()=>billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1'),/month_not_closed/);
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  assert.throws(()=>billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1'),/commercial_terms_not_accepted/);
  billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
  assert.throws(()=>billing.finalizeCommercialInvoice(INTERNAL,'2026-09','care-v1'),/internal_usage_not_billable/);
  const withoutStore=new BillingService(f.ledger);
  assert.throws(()=>withoutStore.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1'),/commercial_terms_unavailable/);
  f.ledger.provisionTenant({...f.tenant,companyId:'internal-flagged',licenseId:'internal-license',billingMode:'internal_cost'});
  assert.throws(()=>billing.commercialTerms!.publish(careTermsDraft({tenant:{...f.tenant,companyId:'internal-flagged'}},'care-v1','12500')),/internal_usage_not_billable/);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1');
  // Only the version the owner accepted for the month can name the closed invoice.
  assert.throws(()=>billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v0'),/commercial_terms_stale/);
  assert.throws(()=>billing.commercialTerms!.publish(careTermsDraft(f,'care-v2','6000')),/commercial_period_already_closed/);
  f.setTime(Date.parse('2026-12-01T00:00:00Z'));
  const later=billing.commercialTerms!.publish(careTermsDraft(f,'care-nov','12500',{period:'2026-11'}));billing.commercialTerms!.accept(f.owner,'2026-11','care-nov',later.digest);
  billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-11','care-nov');
  const october=billing.commercialTerms!.publish(careTermsDraft(f,'care-oct','12500',{period:'2026-10'}));billing.commercialTerms!.accept(f.owner,'2026-10','care-oct',october.digest);
  assert.throws(()=>billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-10','care-oct'),/invoice_period_out_of_order/);
  assert.equal(f.db.all('SELECT id FROM invoices').length,2);assert.equal(invoice.id,'RB-000001');
  f.db.verify();
});

test('a care credit against a paid invoice is carried to the next invoice or refunded through the adapter, never both, and the paid invoice stays as issued',async()=>{
  const f=setup();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const stub=stubAdapter(f);
  const billing=new BillingService(f.ledger,stub.adapter,{authorizeCollection:true,internalCompanyId:INTERNAL});
  accepted(f,billing);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1');
  assert.throws(()=>billing.creditCare(f.tenant.companyId,invoice.id,'credit-one','20000','synthetic-goodwill'),/credit_exceeds_charge/);
  assert.deepEqual(billing.creditCare(f.tenant.companyId,invoice.id,'credit-one','500','synthetic-goodwill'),{duplicate:false});
  assert.deepEqual(billing.creditCare(f.tenant.companyId,invoice.id,'credit-one','500','synthetic-goodwill'),{duplicate:true});
  assert.throws(()=>billing.creditCare(f.tenant.companyId,invoice.id,'credit-one','600','synthetic-goodwill'),/credit_conflict/);
  assert.throws(()=>billing.creditCare('company-b',invoice.id,'credit-b','500','synthetic-goodwill'),/invoice_not_found/);
  const credit=f.db.get<{seq:number}>("SELECT seq FROM events WHERE kind='care_credit'")!.seq;
  // Unpaid: a refund has nothing to refund from; the credit waits.
  await assert.rejects(billing.refundCareCredit(f.tenant.companyId,credit,'refund-one'),/payment_not_settled/);
  const session=await billing.checkout(f.owner,invoice.id);
  const stored=JSON.parse(f.db.get<{body:string}>('SELECT body FROM checkouts WHERE invoice=?',invoice.id)!.body);
  stub.settle({eventId:'event-paid',transactionId:'transaction-one',invoiceId:invoice.id,attemptId:stored.attemptId,sessionId:session.sessionId,amountCents:invoice.totalCents,currency:'AUD',settledAt:f.now()});
  assert.deepEqual(await billing.webhook(Buffer.from('{}'),'sig'),{duplicate:false});
  assert.equal(billing.receipt(f.owner,invoice.id).mode,'sandbox');
  // Second credit: carried to October as a line; the first is refunded instead.
  billing.creditCare(f.tenant.companyId,invoice.id,'credit-two','700','synthetic-correction');
  assert.deepEqual(await billing.refundCareCredit(f.tenant.companyId,credit,'refund-one'),{refundId:'refund-one',state:'pending_verified_settlement'});
  assert.deepEqual(stub.refunds,['refund-one']);
  await assert.rejects(billing.refundCareCredit(f.tenant.companyId,credit,'refund-two'),/refund_reconciliation_required/);
  stub.refund({eventId:'refund-event',refundId:'refund-one',providerRefundId:'square-refund-one',transactionId:'transaction-one',amountCents:'500',currency:'AUD',settledAt:f.now()});
  await billing.refundWebhook(Buffer.from('{}'),'sig');await billing.refundWebhook(Buffer.from('{}'),'sig');
  assert.equal(billing.receipt(f.owner,invoice.id).refundedCents,'500');assert.equal(f.db.all('SELECT * FROM refunds').length,1);
  f.setTime(Date.parse('2026-11-01T00:00:00Z'));
  const october=billing.commercialTerms!.publish(careTermsDraft(f,'care-oct','12500',{period:'2026-10'}));billing.commercialTerms!.accept(f.owner,'2026-10','care-oct',october.digest);
  const next=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-10','care-oct');
  assert.deepEqual(next.lines.map(l=>[l.description,l.amountCents,l.sourceInvoice??null]),[['RealBud software and routine maintenance — monthly care','12500',null],['Care credit','-700',invoice.id]]);
  assert.equal(next.totalCents,'11800');
  const second=f.db.get<{seq:number}>("SELECT seq FROM events WHERE kind='care_credit' ORDER BY seq DESC")!.seq;
  await assert.rejects(billing.refundCareCredit(f.tenant.companyId,second,'refund-three'),/credit_already_applied/);
  assert.equal(billing.invoice(f.owner,invoice.id).totalCents,'12500');
  assert.match(invoiceHtml(next),/Credit against RB-000001/);
  f.db.verify();
});

test('checkout needs a composed payment adapter, and an adapter needs explicit authorization',async()=>{
  const f=setup();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  accepted(f,billing);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1');
  await assert.rejects(billing.checkout(f.owner,invoice.id),/payment_provider_unselected/);
  assert.throws(()=>new BillingService(f.ledger,stubAdapter(f).adapter,{internalCompanyId:INTERNAL}),/payment_collection_not_authorized/);
  assert.equal(f.db.get('SELECT * FROM checkouts'),undefined);
});

test('printable invoice escapes tenant content and carries no secret',()=>{
  const f=setup();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  accepted(f,billing);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1');
  const html=invoiceHtml({...invoice,customer:{...invoice.customer,name:'<script>evil</script>'}});
  assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('nano'));
  assert(html.includes(invoice.commercialTerms!.digest));
});

test('care collection composes from the environment: off by default, refuses a half-configured sandbox or live mode by name',()=>{
  const f=setup();
  const never=async()=>{throw new Error('network must stay off');};
  const off=composeCareCollection({env:{},ledger:f.ledger,fetch:never});
  assert.equal(off.careCollection,'off');assert.equal(off.squareWebhooks,false);assert.equal(off.billing.commercialTerms,undefined);
  const local=composeCareCollection({env:{REALBUD_PAYMENT_MODE:'local',REALBUD_INTERNAL_COMPANY_ID:INTERNAL},ledger:f.ledger,fetch:never});
  assert.equal(local.billing.commercialTerms?.internalCompanyId,INTERNAL);
  assert.throws(()=>composeCareCollection({env:{REALBUD_PAYMENT_MODE:'production'},ledger:f.ledger,fetch:never}),/care_collection_unconfigured:REALBUD_PAYMENT_MODE/);
  const sandbox:NodeJS.ProcessEnv={REALBUD_PAYMENT_MODE:'sandbox',REALBUD_AUTHORIZE_COLLECTION:'1',SQUARE_ACCESS_TOKEN:'synthetic-sandbox-token',SQUARE_MERCHANT_ID:'merchant-a',SQUARE_LOCATION_ID:'location-a',
    SQUARE_NOTIFICATION_URL:'https://gateway.realbud.example/v1/webhooks/square',SQUARE_WEBHOOK_SIGNATURE_KEY:'synthetic-square-webhook-signature-key',REALBUD_INTERNAL_COMPANY_ID:INTERNAL};
  assert.throws(()=>composeCareCollection({env:{...sandbox,REALBUD_AUTHORIZE_COLLECTION:''},ledger:f.ledger,fetch:never}),/care_collection_unconfigured:REALBUD_AUTHORIZE_COLLECTION/);
  for(const name of ['SQUARE_ACCESS_TOKEN','SQUARE_MERCHANT_ID','SQUARE_LOCATION_ID','SQUARE_NOTIFICATION_URL','SQUARE_WEBHOOK_SIGNATURE_KEY','REALBUD_INTERNAL_COMPANY_ID']) {
    assert.throws(()=>composeCareCollection({env:{...sandbox,[name]:' '},ledger:f.ledger,fetch:never}),new RegExp(`care_collection_unconfigured:${name}$`),name);
  }
  const composed=composeCareCollection({env:sandbox,ledger:f.ledger,fetch:never});
  assert.equal(composed.careCollection,'sandbox');assert.equal(composed.squareWebhooks,true);
  assert.throws(()=>composeCareCollection({env:{...sandbox,REALBUD_PAYMENT_MODE:'live'},ledger:f.ledger,fetch:never}),/care_collection_unconfigured:REALBUD_SELLER_BASIS_DIGEST/);
  const live={...sandbox,REALBUD_PAYMENT_MODE:'live',REALBUD_SELLER_BASIS_DIGEST:'0'.repeat(64),REALBUD_SELLER_BASIS_APPROVAL_REF:'ref-1',REALBUD_PRODUCTION_INVOICE_APPROVAL_REF:'ref-2',REALBUD_MANAGED_PROJECT_VERIFIED_REF:'ref-3'};
  assert.throws(()=>composeCareCollection({env:{...live,REALBUD_MANAGED_PROJECT_VERIFIED_REF:''},ledger:f.ledger,fetch:never}),/care_collection_unconfigured:REALBUD_MANAGED_PROJECT_VERIFIED_REF/);
  assert.equal(composeCareCollection({env:live,ledger:f.ledger,fetch:never}).careCollection,'live');
});
