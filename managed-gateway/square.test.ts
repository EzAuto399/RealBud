import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture } from './testing.ts';
import { SquareBilling } from './square.ts';
import { digest } from './ledger.ts';
const URL='https://realbud.example/webhooks/square',KEY='synthetic-signature-key';
function setup() {
  const f=fixture();const calls:{path:string;method:string;body:Record<string,unknown>}[]=[];let loseOrder=false,loseInvoice=false;let order:Record<string,unknown>,invoice:Record<string,unknown>;
  const payments=new Map<string,unknown>(),refunds=new Map<string,unknown>();
  const transport=(async(url,options)=>{
    const path=new globalThis.URL(String(url)).pathname,method=options?.method??'GET',body=JSON.parse(String(options?.body??'{}'));calls.push({path,method,body});
    assert.equal(String(url).startsWith('https://connect.squareup.com/'),true);assert.equal((options?.headers as Record<string,string>)['Square-Version'],'2026-08-19');
    let result:unknown;
    if(path==='/v2/merchants/merchant-a')result={merchant:{id:'merchant-a'}};
    else if(path==='/v2/locations/location-a')result={location:{id:'location-a',merchant_id:'merchant-a',currency:'AUD',status:'ACTIVE'}};
    else if(path==='/v2/orders' && method==='POST'){const amount=body.order.line_items[0].base_price_money.amount;order={...body.order,id:'order-a',version:1,total_money:{amount,currency:'AUD'},total_tax_money:{amount:Math.floor((amount+5)/11),currency:'AUD'}};if(loseOrder)throw Error('lost response');result={order};}
    else if(path==='/v2/invoices' && method==='POST'){invoice={...body.invoice,id:'invoice-a',status:'DRAFT',version:0,payment_requests:[{...body.invoice.payment_requests[0],computed_amount_money:order.total_money}]};if(loseInvoice)throw Error('lost response');result={invoice};}
    else if(path==='/v2/orders/order-a')result={order};
    else if(path==='/v2/invoices/invoice-a')result={invoice};
    else if(path.startsWith('/v2/payments/'))result={payment:payments.get(path.split('/').at(-1)!)};
    else if(path.startsWith('/v2/refunds/'))result={refund:refunds.get(path.split('/').at(-1)!)};
    else throw Error(`Unexpected fixture path ${path}`);
    return Response.json(result);
  }) as typeof fetch;
  const square=new SquareBilling({ledger:f.ledger,fetch:transport,secret:async()=>'mock-secret',notificationUrl:URL,signatureKey:async()=>KEY});
  square.map({companyId:f.tenant.companyId,merchantId:'merchant-a',customerId:'customer-a',locationId:'location-a',evidence:'fixture-mapping'});
  const statement=()=>{const s=square.closeStatement(f.tenant.companyId,'2026-08','accepted-care-month');square.accept(f.owner,s.id,digest(s));return s;};
  const sign=(type:string,entity:string,eventId:string,merchant='merchant-a')=>{const raw=Buffer.from(JSON.stringify({merchant_id:merchant,event_id:eventId,type,data:{id:entity}}));return {raw,signature:createHmac('sha256',KEY).update(URL).update(raw).digest('base64')};};
  return {f,square,calls,statement,sign,payments,refunds,loseOrder:()=>{loseOrder=true;},loseInvoice:()=>{loseInvoice=true;},invoice:()=>invoice};
}
test('Square draft: explicit mapping, accepted immutable GST total, order first, no publishing or charging',async()=>{
  const s=setup();try{const statement=s.statement();assert.equal(statement.kind,'Usage statement');assert.equal(statement.totalCents,12500);assert.equal(statement.gstCents,1136);
    assert.throws(()=>s.square.accept({...s.f.owner,role:'billing_reader'},statement.id,digest(statement)),/forbidden/);
    assert.throws(()=>s.square.statement({...s.f.owner,companyId:'other'},statement.id),/statement_not_found/);
    assert.deepEqual(await s.square.createDraft(s.f.owner,statement.id,'2026-09-30'),{orderId:'order-a',invoiceId:'invoice-a',invoiceVersion:0});
    const posts=s.calls.filter(c=>c.method==='POST');assert.deepEqual(posts.map(c=>c.path),['/v2/orders','/v2/invoices']);assert.equal((posts[0].body.order as {taxes:{type:string}[]}).taxes[0].type,'INCLUSIVE');
    await s.square.createDraft(s.f.owner,statement.id,'2026-09-30');assert.equal(s.calls.filter(c=>c.method==='POST').length,2);
    await assert.rejects(s.square.createDraft(s.f.owner,statement.id,'2026-10-01'),/square_outbox_conflict/);
    assert.throws(()=>s.f.db.run('UPDATE statements SET body=? WHERE id=?','{}',statement.id),/immutable_record/);
    assert.throws(()=>s.f.billing.finalizeLocalInvoice(s.f.tenant.companyId,'2026-08','same-care'),/period_already_stated/);s.f.db.verify();
  }finally{s.f.close();}
});
for(const operation of ['order','invoice'] as const)test(`Square uncertain ${operation} needs GET reconciliation; repeat click cannot create a second effect`,async()=>{
  const s=setup();try{const statement=s.statement();operation==='order'?s.loseOrder():s.loseInvoice();
    await assert.rejects(s.square.createDraft(s.f.owner,statement.id,'2026-09-30'),/square_reconciliation_required/);
    const count=s.calls.filter(c=>c.method==='POST').length;await assert.rejects(s.square.createDraft(s.f.owner,statement.id,'2026-09-30'),/square_reconciliation_required/);assert.equal(s.calls.filter(c=>c.method==='POST').length,count);
    await s.square.reconcileDraft(s.f.owner,statement.id,operation,`${operation}-a`);
    assert.equal((await s.square.createDraft(s.f.owner,statement.id,'2026-09-30')).invoiceId,'invoice-a');s.f.db.verify();
  }finally{s.f.close();}
});
test('Square verifies raw URL-bound signature and retrieved partial/manual payments; paid invoice status alone records nothing',async()=>{
  const s=setup();try{const statement=s.statement();await s.square.createDraft(s.f.owner,statement.id,'2026-09-30');
    s.invoice().status='PAID';assert.equal(s.square.paymentSummary(s.f.owner,statement.id).paidCents,0);
    for(const [id,amount,source]of [['p1',5000,'CARD'],['p2',7500,'EXTERNAL']] as const){s.payments.set(id,{id,status:'COMPLETED',location_id:'location-a',order_id:'order-a',customer_id:'customer-a',source_type:source,total_money:{amount,currency:'AUD'},updated_at:'2026-09-15T00:00:00Z'});const signed=s.sign('payment.updated',id,`event-${id}`);await s.square.webhook(signed.raw,signed.signature);await s.square.webhook(signed.raw,signed.signature);}
    assert.deepEqual(s.square.paymentSummary(s.f.owner,statement.id),{paidCents:12500,refundedCents:0,netReceivedCents:12500,reconciliationRequired:false,allocationIssues:[]});
    const signed=s.sign('payment.updated','p1','other-event');await assert.rejects(s.square.webhook(Buffer.concat([signed.raw,Buffer.from(' ')]),signed.signature),/invalid_square_signature/);
    const wrong=s.sign('payment.updated','p1','wrong-merchant','merchant-b');await assert.rejects(s.square.webhook(wrong.raw,wrong.signature),/square_money_scope_mismatch/);
    const conflict=s.sign('payment.updated','p2','event-p1');await assert.rejects(s.square.webhook(conflict.raw,conflict.signature),/square_event_conflict/);
    assert.throws(()=>s.square.paymentSummary({...s.f.owner,companyId:'other'},statement.id),/statement_not_found/);
    const refund={id:'refund1',payment_id:'p2',status:'PENDING',location_id:'location-a',amount_money:{amount:1000,currency:'AUD'},updated_at:'2026-09-15T00:01:00Z'};s.refunds.set('refund1',refund);const refundEvent=s.sign('refund.updated','refund1','refund-event');await s.square.webhook(refundEvent.raw,refundEvent.signature);assert.equal(s.square.paymentSummary(s.f.owner,statement.id).refundedCents,0);
    refund.status='COMPLETED';await s.square.webhook(refundEvent.raw,refundEvent.signature);await s.square.webhook(refundEvent.raw,refundEvent.signature);assert.equal(s.square.paymentSummary(s.f.owner,statement.id).netReceivedCents,11500);
    s.refunds.set('refund2',{...refund,id:'refund2',amount_money:{amount:7000,currency:'AUD'}});const tooMuch=s.sign('refund.updated','refund2','refund2-event');await assert.rejects(s.square.webhook(tooMuch.raw,tooMuch.signature),/refund_exceeds_payment/);
    assert(s.calls.filter(c=>c.path.startsWith('/v2/payments/') || c.path.startsWith('/v2/refunds/')).every(c=>c.method==='GET'));s.f.db.verify();
  }finally{s.f.close();}
});
test('unknown usage carries forward while care closes; late settled usage billed once',()=>{
  const s=setup();try{const f=s.f;const g=f.grant();const r=f.ledger.reserve(g,'fixture-host-key','fp','idem',f.provider.bound(f.request)).record;f.ledger.dispatch(r.id,g,f.provider.id);f.ledger.unknown(r.id,'interrupted');f.setTime(Date.parse('2026-10-15T00:00:00Z'));
    const first=s.square.closeStatement(f.tenant.companyId,'2026-09','agreed-care');assert.deepEqual(first.deferredRequestIds,[r.id]);assert.equal(first.totalCents,12500);
    f.ledger.settle(r.id,f.provider.id,f.evidence({source:'provider_reconciliation'}));f.setTime(Date.parse('2026-11-15T00:00:00Z'));const next=s.square.closeStatement(f.tenant.companyId,'2026-10');assert.equal(next.totalCents,2);assert.equal(next.lines.length,1);assert.equal(first.totalCents,12500);
    assert.equal(s.square.closeStatement(f.tenant.companyId,'2026-10').id,next.id);
  }finally{s.f.close();}
});
test('Square disabled transport cannot read a secret or create an outbox dispatch',async()=>{
  const f=fixture();try{let secrets=0;const square=new SquareBilling({ledger:f.ledger,secret:async()=>{secrets++;return 'forbidden';},signatureKey:async()=>KEY,notificationUrl:URL});
    await assert.rejects(square.createDraft(f.owner,'unknown','2026-09-30'),/external_transport_disabled/);assert.equal(secrets,0);assert.equal(f.db.all('SELECT * FROM square_outbox').length,0);
  }finally{f.close();}
});

test('Square mismatched payment currency, recipient or changed invoice totals never create receipt money',async()=>{
  const s=setup();try{const statement=s.statement();await s.square.createDraft(s.f.owner,statement.id,'2026-09-30');
    const payment={id:'bad-payment',status:'COMPLETED',location_id:'location-a',order_id:'order-a',customer_id:'customer-a',source_type:'CARD',total_money:{amount:100,currency:'USD'},updated_at:'2026-09-15T00:00:00Z'};s.payments.set(payment.id,payment);const event=s.sign('payment.updated',payment.id,'bad-event');
    await assert.rejects(s.square.webhook(event.raw,event.signature),/square_currency_mismatch/);payment.total_money.currency='AUD';payment.customer_id='other';await assert.rejects(s.square.webhook(event.raw,event.signature),/square_payment_scope_mismatch/);payment.customer_id='customer-a';
    (s.invoice().payment_requests as {computed_amount_money:{amount:number}}[])[0].computed_amount_money.amount=999;await assert.rejects(s.square.webhook(event.raw,event.signature),/square_invoice_amount_mismatch/);assert.equal(s.square.paymentSummary(s.f.owner,statement.id).paidCents,0);
  }finally{s.f.close();}
});
