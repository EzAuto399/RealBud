import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingService } from './billing.ts';
import { createGatewayServer } from './http.ts';
import { SquareHostedPaymentAdapter } from './square-payment.ts';
import { SquareBilling } from './square.ts';
import { fixture } from './testing.ts';

const NOTIFY='https://gateway.realbud.example/v1/webhooks/square',KEY='synthetic-square-webhook-signature-key';
async function setup() {
  const f=fixture();await f.run();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const invoice=f.billing.finalizeLocalInvoice(f.tenant.companyId,'2026-09','fixture-care-agreement');
  const calls:{method:string;path:string;body:Record<string,unknown>}[]=[];
  const payments=new Map<string,Record<string,unknown>>(),refunds=new Map<string,Record<string,unknown>>();
  let order:Record<string,unknown>|undefined,failAfterCreate=false;
  const transport=(async(url,options)=>{
    assert.equal(new URL(String(url)).origin,'https://connect.squareupsandbox.com');
    const path=new URL(String(url)).pathname,method=options?.method??'GET',body=JSON.parse(String(options?.body??'{}')) as Record<string,unknown>;
    assert.equal((options?.headers as Record<string,string>)['Square-Version'],'2026-08-19');
    calls.push({method,path,body});
    if(path==='/v2/merchants/merchant-a')return Response.json({merchant:{id:'merchant-a',status:'ACTIVE',country:'AU',currency:'AUD'}});
    if(path==='/v2/locations/location-a')return Response.json({location:{id:'location-a',merchant_id:'merchant-a',currency:'AUD',status:'ACTIVE'}});
    if(path==='/v2/online-checkout/payment-links' && method==='POST') {
      const submitted=body.order as Record<string,unknown>;
      order={...submitted,id:'square-order-one',total_money:{amount:Number(invoice.totalCents),currency:'AUD'},total_tax_money:{amount:Number(invoice.gstCents),currency:'AUD'}};
      if(failAfterCreate)throw Error('synthetic lost response');
      return Response.json({payment_link:{id:'square-link-one',order_id:'square-order-one',url:'https://connect.squareupsandbox.com/v2/online-checkout/sandbox-testing-panel/one'}});
    }
    if(path==='/v2/orders/square-order-one')return Response.json({order});
    if(path.startsWith('/v2/payments/'))return Response.json({payment:payments.get(path.split('/').at(-1)!)});
    if(path==='/v2/refunds' && method==='POST')return Response.json({refund:{id:'square-refund-one',status:'PENDING'}});
    if(path.startsWith('/v2/refunds/'))return Response.json({refund:refunds.get(path.split('/').at(-1)!)});
    throw Error(`unexpected Square fixture path ${method} ${path}`);
  }) as typeof fetch;
  const map=new SquareBilling({ledger:f.ledger,secret:async()=>'unused',signatureKey:async()=>KEY,notificationUrl:NOTIFY});
  map.map({companyId:f.tenant.companyId,merchantId:'merchant-a',locationId:'location-a',customerId:'customer-a',evidence:'customer-mapping-reviewed'});
  const adapter=new SquareHostedPaymentAdapter({ledger:f.ledger,environment:'sandbox',fetchImpl:transport,accessToken:'synthetic-sandbox-token',signatureKey:KEY,notificationUrl:NOTIFY,merchantId:'merchant-a',locationId:'location-a',internalCompanyId:'realbud-internal'});
  const billing=new BillingService(f.ledger,adapter,{authorizeCollection:true});
  const signed=(type:string,remoteId:string,eventId:string,at=f.now(),merchant='merchant-a')=>{
    const raw=Buffer.from(JSON.stringify({merchant_id:merchant,type,event_id:eventId,created_at:new Date(at).toISOString(),data:{type:type.startsWith('refund.')?'refund':'payment',id:remoteId}}));
    return {raw,signature:createHmac('sha256',KEY).update(NOTIFY).update(raw).digest('base64')};
  };
  return {f,invoice,adapter,billing,calls,payments,refunds,signed,order:()=>order,loseResponse:()=>{failAfterCreate=true;}};
}

test('sandbox checkout binds company, immutable invoice, mapped Square seller and order with one idempotent payment link',async()=>{
  const s=await setup();try {
    const first=await s.billing.checkout(s.f.owner,s.invoice.id);
    const second=await s.billing.checkout(s.f.owner,s.invoice.id);
    assert.deepEqual(second,first);
    assert.equal(first.sessionId,'square-order-one');
    assert.equal(s.calls.filter(call=>call.path==='/v2/online-checkout/payment-links').length,1);
    const write=s.calls.find(call=>call.path==='/v2/online-checkout/payment-links')!.body;
    assert.equal(write.idempotency_key,`checkout:${s.invoice.id}`);
    assert.equal((write.checkout_options as Record<string,unknown>).allow_tipping,false);
    assert.deepEqual((write.checkout_options as Record<string,unknown>).accepted_payment_methods,{apple_pay:false,google_pay:false,cash_app_pay:false,afterpay_clearpay:false});
    assert.equal(((write.order as Record<string,unknown>).taxes as Record<string,unknown>[])[0].type,'INCLUSIVE');
    assert.equal(((write.order as Record<string,unknown>).line_items as {base_price_money:{amount:number}}[])[0].base_price_money.amount,Number(s.invoice.totalCents));
    assert.equal(s.billing.portalInvoices(s.f.owner)[0].paid,false);
    assert.throws(()=>s.billing.receipt(s.f.owner,s.invoice.id),/payment_not_settled/);
    s.f.db.verify();
  }finally{s.f.close();}
});

test('signed notification alone is insufficient: only matching retrieved completed payment settles exactly once',async()=>{
  const s=await setup();try {
    await s.billing.checkout(s.f.owner,s.invoice.id);
    const amount=Number(s.invoice.totalCents),payment={id:'payment-one',status:'PENDING',source_type:'CARD',location_id:'location-a',order_id:'square-order-one',amount_money:{amount,currency:'AUD'},total_money:{amount,currency:'AUD'},updated_at:new Date(s.f.now()).toISOString()};
    s.payments.set('payment-one',payment);
    const event=s.signed('payment.updated','payment-one','payment-event-one');
    assert.deepEqual(await s.billing.webhook(event.raw,event.signature),{ignored:true});
    assert.equal(s.billing.portalInvoices(s.f.owner)[0].paid,false);
    payment.status='COMPLETED';
    assert.deepEqual(await s.billing.webhook(event.raw,event.signature),{duplicate:false});
    assert.deepEqual(await s.billing.webhook(event.raw,event.signature),{duplicate:true});
    const second=s.signed('payment.updated','payment-one','payment-event-two');
    assert.deepEqual(await s.billing.webhook(second.raw,second.signature),{duplicate:true});
    assert.equal(s.billing.receipt(s.f.owner,s.invoice.id).mode,'sandbox');
    assert.equal(s.billing.portalInvoices(s.f.owner)[0].paid,true);
    assert.equal(s.f.db.all('SELECT * FROM payments').length,1);
    assert.equal(s.f.db.all("SELECT * FROM events WHERE kind='payment_settled'").length,1);
    s.f.db.verify();
  }finally{s.f.close();}
});

test('wrong signature, old event, wrong merchant, wrong order and wrong amount do not mark an invoice paid',async()=>{
  const s=await setup();try {
    await s.billing.checkout(s.f.owner,s.invoice.id);
    const amount=Number(s.invoice.totalCents);
    s.payments.set('payment-one',{id:'payment-one',status:'COMPLETED',source_type:'CARD',location_id:'location-a',order_id:'wrong-order',amount_money:{amount,currency:'AUD'},total_money:{amount,currency:'AUD'},updated_at:new Date(s.f.now()).toISOString()});
    const event=s.signed('payment.updated','payment-one','payment-event-one');
    await assert.rejects(s.billing.webhook(Buffer.concat([event.raw,Buffer.from(' ')]),event.signature),/invalid_square_signature/);
    const old=s.signed('payment.updated','payment-one','old-event',s.f.now()-8*86400000);
    await assert.rejects(s.billing.webhook(old.raw,old.signature),/stale_square_event/);
    const foreign=s.signed('payment.updated','payment-one','foreign-event',s.f.now(),'other-merchant');
    await assert.rejects(s.billing.webhook(foreign.raw,foreign.signature),/square_merchant_mismatch/);
    await assert.rejects(s.billing.webhook(event.raw,event.signature));
    s.payments.get('payment-one')!.order_id='square-order-one';
    s.payments.get('payment-one')!.total_money={amount:amount+1,currency:'AUD'};
    await assert.rejects(s.billing.webhook(event.raw,event.signature),/square_payment_amount_mismatch/);
    assert.equal(s.billing.portalInvoices(s.f.owner)[0].paid,false);
    s.f.db.verify();
  }finally{s.f.close();}
});

test('completed Square payments outside RealBud checkout orders are ignored',async()=>{
  const s=await setup();try {
    await s.billing.checkout(s.f.owner,s.invoice.id);
    const amount=Number(s.invoice.totalCents);
    s.payments.set('unrelated-payment',{id:'unrelated-payment',status:'COMPLETED',source_type:'CARD',location_id:'location-a',order_id:'square-order-one',amount_money:{amount,currency:'AUD'},total_money:{amount,currency:'AUD'},updated_at:new Date(s.f.now()).toISOString()});
    s.order()!.reference_id='another-application';
    const event=s.signed('payment.updated','unrelated-payment','unrelated-event');
    assert.deepEqual(await s.billing.webhook(event.raw,event.signature),{ignored:true});
    assert.equal(s.billing.portalInvoices(s.f.owner)[0].paid,false);
  }finally{s.f.close();}
});

test('uncertain Square create is not sent again; a later verified settlement reconciles the durable attempt',async()=>{
  const s=await setup();try {
    s.loseResponse();
    await assert.rejects(s.billing.checkout(s.f.owner,s.invoice.id),/checkout_reconciliation_required/);
    await assert.rejects(s.billing.checkout(s.f.owner,s.invoice.id),/checkout_reconciliation_required/);
    assert.equal(s.calls.filter(call=>call.path==='/v2/online-checkout/payment-links').length,1);
    const amount=Number(s.invoice.totalCents);
    s.payments.set('payment-one',{id:'payment-one',status:'COMPLETED',source_type:'CARD',location_id:'location-a',order_id:'square-order-one',amount_money:{amount,currency:'AUD'},total_money:{amount,currency:'AUD'},updated_at:new Date(s.f.now()).toISOString()});
    const event=s.signed('payment.updated','payment-one','late-payment-event');
    await s.billing.webhook(event.raw,event.signature);
    assert.equal(s.billing.receipt(s.f.owner,s.invoice.id).amountCents,s.invoice.totalCents);
    s.f.db.verify();
  }finally{s.f.close();}
});

test('self billing and missing per-tenant mapping cannot create a Square checkout',async()=>{
  const s=await setup();try {
    s.f.ledger.provisionTenant({...s.f.tenant,companyId:'company-b',licenseId:'license-b',customerName:'Fictional Agency B'});
    const unmapped=s.f.billing.finalizeLocalInvoice('company-b','2026-09','another-fixture-agreement');
    await assert.rejects(s.billing.checkout({...s.f.owner,companyId:'company-b'},unmapped.id),/square_mapping_required/);
    assert.equal(s.calls.length,0);
    assert.equal(s.f.db.get('SELECT * FROM checkouts WHERE invoice=?',unmapped.id),undefined);
    const local=s.f.db.get<{body:string}>('SELECT body FROM checkouts WHERE invoice=?',s.invoice.id);
    assert.equal(local,undefined);
    const internal=new SquareHostedPaymentAdapter({ledger:s.f.ledger,environment:'sandbox',fetchImpl:async()=>{throw Error('network must stay off');},accessToken:'fixture',signatureKey:KEY,notificationUrl:NOTIFY,merchantId:'merchant-a',locationId:'location-a',internalCompanyId:s.f.tenant.companyId});
    const billing=new BillingService(s.f.ledger,internal,{authorizeCollection:true});
    await assert.rejects(billing.checkout(s.f.owner,s.invoice.id),/internal_usage_not_collectible/);
    assert.equal(s.calls.length,0);
    assert.equal(s.f.db.get('SELECT * FROM checkouts WHERE invoice=?',s.invoice.id),undefined);
  }finally{s.f.close();}
});

test('refund is requested once and the receipt changes only after a completed authenticated Square refund',async()=>{
  const s=await setup();try {
    await s.billing.checkout(s.f.owner,s.invoice.id);
    const amount=Number(s.invoice.totalCents),payment={id:'payment-one',status:'COMPLETED',source_type:'CARD',location_id:'location-a',order_id:'square-order-one',amount_money:{amount,currency:'AUD'},total_money:{amount,currency:'AUD'},updated_at:new Date(s.f.now()).toISOString()};
    s.payments.set('payment-one',payment);
    const paid=s.signed('payment.updated','payment-one','payment-event');await s.billing.webhook(paid.raw,paid.signature);
    const request=s.f.ledger.requests(s.f.tenant.companyId)[0];s.f.ledger.credit(request.id,'credit-for-refund','10000000','synthetic-correction');
    const credit=s.f.db.get<{seq:number}>("SELECT seq FROM events WHERE kind='credit'")!.seq;
    assert.deepEqual(await s.billing.refundLocalCredit(s.f.tenant.companyId,credit,'refund-one'),{refundId:'refund-one',state:'pending_verified_settlement'});
    await assert.rejects(s.billing.refundLocalCredit(s.f.tenant.companyId,credit,'refund-two'),/refund_reconciliation_required/);
    const posted=s.calls.filter(call=>call.path==='/v2/refunds' && call.method==='POST');assert.equal(posted.length,1);
    assert.equal((posted[0].body.amount_money as {amount:number}).amount,1);
    const refund={id:'square-refund-one',payment_id:'payment-one',status:'PENDING',location_id:'location-a',amount_money:{amount:1,currency:'AUD'},reason:'RealBud credit refund-one',updated_at:new Date(s.f.now()).toISOString()};
    s.refunds.set('square-refund-one',refund);
    const event=s.signed('refund.updated','square-refund-one','refund-event');
    assert.deepEqual(await s.billing.refundWebhook(event.raw,event.signature),{ignored:true});
    assert.equal(s.billing.receipt(s.f.owner,s.invoice.id).refundedCents,'0');
    refund.status='COMPLETED';
    await s.billing.refundWebhook(event.raw,event.signature);
    await s.billing.refundWebhook(event.raw,event.signature);
    assert.equal(s.billing.receipt(s.f.owner,s.invoice.id).refundedCents,'1');
    assert.equal(s.f.db.all('SELECT * FROM refunds').length,1);
    s.f.db.verify();
  }finally{s.f.close();}
});

test('one Square webhook URL dispatches payment and refund and rejects local-simulator signatures',async()=>{
  const s=await setup();const server=createGatewayServer({gateway:s.f.gateway(),billing:s.billing,squareWebhooks:true,allowedOrigins:new Set(),portal:{async authenticate(){return s.f.owner;}}});
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const local=await fetch(`${base}/v1/webhooks/payment`,{method:'POST',headers:{'x-realbud-payment-signature':'bad'},body:'{}'});assert.equal(local.status,503);
    const bad=await fetch(`${base}/v1/webhooks/square`,{method:'POST',headers:{'x-square-hmacsha256-signature':'bad'},body:'{}'});assert.equal(bad.status,401);
    const event=s.signed('payment.updated','pending-payment','pending-event');
    s.payments.set('pending-payment',{id:'pending-payment',status:'PENDING'});
    const response=await fetch(`${base}/v1/webhooks/square`,{method:'POST',headers:{'x-square-hmacsha256-signature':event.signature},body:event.raw});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ignored:true});
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));s.f.close();}
});
