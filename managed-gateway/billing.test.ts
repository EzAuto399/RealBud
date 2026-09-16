import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { BillingService, type HostedPaymentAdapter, type VerifiedPayment } from './billing.ts';
import { invoiceHtml } from './invoice-html.ts';

const cleanups:(()=>void)[]=[];const setup=()=>{const f=fixture();cleanups.push(f.close);return f;};afterEach(()=>{while(cleanups.length)cleanups.pop()!();});
async function paidFixture() {
  const f=setup();await f.run(); f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const invoice=f.billing.finalizeLocalInvoice('company-a','2026-09','fixture-care-agreement');
  const session=await f.billing.checkout(f.owner,invoice.id);
  const stored=JSON.parse(f.db.get<{body:string}>('SELECT body FROM checkouts WHERE invoice=?',invoice.id)!.body);
  const payment:VerifiedPayment={eventId:'event-paid',transactionId:'transaction-one',invoiceId:invoice.id,attemptId:stored.attemptId,sessionId:session.sessionId,amountCents:invoice.totalCents,currency:'AUD',settledAt:f.now()};
  const signed=f.signedEvent({mode:'local',status:'settled',payment});await f.billing.webhook(signed.raw,signed.signature);
  return {f,invoice,session,payment};
}
test('monthly invoice is sequential, itemised, GST-inclusive and care never adds a usage surcharge',async()=>{
  const f=setup();await f.run();f.setTime(Date.parse('2026-10-01T00:00:00Z'));const i=f.billing.finalizeLocalInvoice('company-a','2026-09','fixture-care-agreement');
  assert.equal(i.id,'RB-LOCAL-000001');assert.equal(i.supplier.legalName,'Yo-Da Lai');assert.equal(i.supplier.abn,'84992526369');
  assert.equal(i.totalCents,'12502');assert.equal(i.gstCents,'1137');assert.equal(i.lines.filter(l=>l.description.includes('maintenance')).length,1);assert.equal(i.lines[0].rateVersion,'fixture-r1');
  assert.equal(f.billing.finalizeLocalInvoice('company-a','2026-09','fixture-care-agreement').id,i.id);
  assert.throws(()=>f.billing.finalizeLocalInvoice('company-a','2026-09'),/invoice_close_conflict/);
  assert.throws(()=>f.db.run("UPDATE invoices SET body='{}'"),/immutable_record/);
});
test('no usage produces no AI usage fee, and care requires its own explicit agreement reference',()=>{
  const f=setup();f.setTime(Date.parse('2026-10-01T00:00:00Z'));const i=f.billing.finalizeLocalInvoice('company-a','2026-09');assert.equal(i.totalCents,'0');assert.equal(i.lines.length,0);
});
test('open month and unreconciled provider usage block invoice close',()=>{
  const f=setup();assert.throws(()=>f.billing.finalizeLocalInvoice('company-a','2026-09'),/month_not_closed/);
  const r=f.ledger.reserve(f.grant(),'fixture-host-key','fp','idem',f.provider.bound(f.request)).record;f.ledger.dispatch(r.id,f.grant(),f.provider.id);f.ledger.unknown(r.id,'interrupted');
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));assert.throws(()=>f.billing.finalizeLocalInvoice('company-a','2026-09'),/unreconciled_usage/);
});
test('receipt exists only after signed matching verified settlement, never from a browser return',async()=>{
  const f=setup();await f.run();f.setTime(Date.parse('2026-10-01T00:00:00Z'));const i=f.billing.finalizeLocalInvoice('company-a','2026-09');
  await f.billing.checkout(f.owner,i.id);assert.throws(()=>f.billing.receipt(f.owner,i.id),/payment_not_settled/);
  const signed=f.signedEvent({mode:'local',status:'pending',payment:{}});await f.billing.webhook(signed.raw,signed.signature);assert.throws(()=>f.billing.receipt(f.owner,i.id),/payment_not_settled/);
});
test('webhook raw bytes, environment, timestamp and amount are authenticated',async()=>{
  const {f,payment}=await paidFixture();
  const valid=f.signedEvent({mode:'local',status:'settled',payment});
  await assert.rejects(f.billing.webhook(Buffer.from('changed'),valid.signature),/invalid_webhook_signature/);
  const old=f.signedEvent({mode:'local',status:'settled',payment},f.now()-300001);await assert.rejects(f.billing.webhook(old.raw,old.signature),/stale_webhook/);
  const live=f.signedEvent({mode:'live',status:'settled',payment});await assert.rejects(f.billing.webhook(live.raw,live.signature),/wrong_payment_environment/);
  const wrong=f.signedEvent({mode:'local',status:'settled',payment:{...payment,eventId:'bad-event',amountCents:'999'}});await assert.rejects(f.billing.webhook(wrong.raw,wrong.signature),/settlement_mismatch/);
});
test('duplicate event IDs and distinct events for one settlement do not duplicate receipts',async()=>{
  const {f,payment,invoice}=await paidFixture();
  for(const eventId of ['event-paid','event-second']) { const signed=f.signedEvent({mode:'local',status:'settled',payment:{...payment,eventId}});await f.billing.webhook(signed.raw,signed.signature); }
  assert.equal(f.db.all('SELECT * FROM payments').length,1);assert.equal(f.db.all("SELECT * FROM events WHERE kind='payment_settled'").length,1);
  assert.equal(f.billing.receipt(f.owner,invoice.id).amountCents,invoice.totalCents);
  assert.throws(()=>f.billing.invoice({...f.owner,companyId:'company-b'},invoice.id),/invoice_not_found/);
  assert.throws(()=>f.billing.receipt({...f.owner,companyId:'company-b'},invoice.id),/invoice_not_found/);
});
test('uncertain checkout creation is durable and never automatically retried',async()=>{
  const f=setup();await f.run();f.setTime(Date.parse('2026-10-01T00:00:00Z'));const invoice=f.billing.finalizeLocalInvoice('company-a','2026-09');let calls=0;
  const adapter:HostedPaymentAdapter={id:'uncertain-local',mode:'local',async createCheckout(){calls++;throw new Error('lost response');},verifyWebhook:f.payment.verifyWebhook.bind(f.payment),requestRefund:f.payment.requestRefund.bind(f.payment),verifyRefundWebhook:f.payment.verifyRefundWebhook.bind(f.payment)};
  const billing=new BillingService(f.ledger,adapter);await assert.rejects(billing.checkout(f.owner,invoice.id),/checkout_reconciliation_required/);await assert.rejects(billing.checkout(f.owner,invoice.id),/checkout_reconciliation_required/);assert.equal(calls,1);
});
test('late settlement can reconcile a lost checkout response using the persisted exact attempt',async()=>{
  const f=setup();await f.run();f.setTime(Date.parse('2026-10-01T00:00:00Z'));const i=f.billing.finalizeLocalInvoice('company-a','2026-09');
  const adapter:HostedPaymentAdapter={id:f.payment.id,mode:'local',async createCheckout(){throw new Error('lost');},verifyWebhook:f.payment.verifyWebhook.bind(f.payment),requestRefund:f.payment.requestRefund.bind(f.payment),verifyRefundWebhook:f.payment.verifyRefundWebhook.bind(f.payment)};
  const billing=new BillingService(f.ledger,adapter);await assert.rejects(billing.checkout(f.owner,i.id));const saved=JSON.parse(f.db.get<{body:string}>('SELECT body FROM checkouts')!.body);
  const payment:VerifiedPayment={eventId:'late',transactionId:'late-payment',invoiceId:i.id,attemptId:saved.attemptId,sessionId:'late-session',amountCents:i.totalCents,currency:'AUD',settledAt:f.now()};
  const signed=f.signedEvent({mode:'local',status:'settled',payment});await billing.webhook(signed.raw,signed.signature);assert.equal(billing.receipt(f.owner,i.id).amountCents,i.totalCents);
});
test('credits after month close become an adjustment and never rewrite the paid invoice',async()=>{
  const {f,invoice}=await paidFixture();const r=f.ledger.requests('company-a')[0];f.ledger.credit(r.id,'late-credit','10000000','verified-correction');
  f.setTime(Date.parse('2026-11-01T00:00:00Z'));const next=f.billing.finalizeLocalInvoice('company-a','2026-10');assert.equal(next.kind,'Adjustment Note');assert.equal(next.totalCents,'-1');assert.equal(next.lines[0].sourceInvoice,invoice.id);
  assert.equal(f.billing.invoice(f.owner,invoice.id).totalCents,'12502');
});
test('refunds require settled payment and an unapplied credit, and signed success is idempotent',async()=>{
  const {f,payment,invoice}=await paidFixture();const r=f.ledger.requests('company-a')[0];f.ledger.credit(r.id,'refund-credit','10000000','customer-refund');
  const credit=f.db.get<{seq:number}>("SELECT seq FROM events WHERE kind='credit'")!.seq;
  await f.billing.refundLocalCredit('company-a',credit,'refund-one');assert.equal(f.billing.receipt(f.owner,invoice.id).refundedCents,'0');
  await assert.rejects(f.billing.refundLocalCredit('company-a',credit,'refund-two'),/refund_reconciliation_required/);
  const refund={eventId:'refund-event',refundId:'refund-one',providerRefundId:'provider-refund-one',transactionId:payment.transactionId,amountCents:'1',currency:'AUD',settledAt:f.now()};
  const signed=f.signedEvent({mode:'local',status:'settled',refund});await f.billing.refundWebhook(signed.raw,signed.signature);await f.billing.refundWebhook(signed.raw,signed.signature);
  assert.equal(f.billing.receipt(f.owner,invoice.id).refundedCents,'1');assert.equal(f.db.all('SELECT * FROM refunds').length,1);
  f.setTime(Date.parse('2026-11-01T00:00:00Z'));assert.equal(f.billing.finalizeLocalInvoice('company-a','2026-10').totalCents,'0');
});
test('payment adapter selection cannot enable production collection in this build',()=>{
  const f=setup();assert.throws(()=>new BillingService(f.ledger,{...f.payment,mode:'live'} as never),/payment_collection_not_authorized/);
});
test('printable invoice escapes tenant content and does not expose payment/provider secrets',async()=>{
  const {f,invoice}=await paidFixture();const html=invoiceHtml({...invoice,customer:{...invoice.customer,name:'<script>evil</script>'}});
  assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('LOCAL TEST DOCUMENT'));assert(html.includes('84 992 526 369'));assert(!html.includes('nano-AUD'));assert(!html.includes(f.paymentKey.toString()));
});
