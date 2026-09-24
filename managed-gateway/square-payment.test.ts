import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingService } from './billing.ts';
import { createGatewayServer } from './http.ts';
import { SquareHostedPaymentAdapter } from './square-payment.ts';
import { recordSquareMapping } from './square-mapping.ts';
import { canonical } from './contracts.ts';
import { careTermsDraft, fixture } from './testing.ts';

const NOTIFY='https://gateway.realbud.example/v1/webhooks/square',KEY='synthetic-square-webhook-signature-key';
async function setup() {
  // AI activity in the ledger proves it never reaches the collected amount.
  const f=fixture();await f.run();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const closer=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  const published=closer.commercialTerms!.publish(careTermsDraft(f,'fixture-commercial-v1','9900',{careAgreementRef:'fixture-care-agreement'}));
  closer.commercialTerms!.accept(f.owner,'2026-09',published.terms.version,published.digest);
  const invoice=closer.finalizeCommercialInvoice(f.tenant.companyId,'2026-09',published.terms.version);
  assert.equal(invoice.totalCents,'9900');
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
  recordSquareMapping(f.ledger,{companyId:f.tenant.companyId,merchantId:'merchant-a',locationId:'location-a',customerId:'customer-a',evidence:'customer-mapping-reviewed'});
  const adapter=new SquareHostedPaymentAdapter({ledger:f.ledger,environment:'sandbox',fetchImpl:transport,accessToken:'synthetic-sandbox-token',signatureKey:KEY,notificationUrl:NOTIFY,merchantId:'merchant-a',locationId:'location-a',internalCompanyId:'realbud-internal'});
  const billing=new BillingService(f.ledger,adapter,{authorizeCollection:true,internalCompanyId:'realbud-internal'});
  const signed=(type:string,remoteId:string,eventId:string,at=f.now(),merchant='merchant-a')=>{
    const raw=Buffer.from(JSON.stringify({merchant_id:merchant,type,event_id:eventId,created_at:new Date(at).toISOString(),data:{type:type.startsWith('refund.')?'refund':'payment',id:remoteId}}));
    return {raw,signature:createHmac('sha256',KEY).update(NOTIFY).update(raw).digest('base64')};
  };
  return {f,invoice,adapter,billing,calls,payments,refunds,signed,transport,order:()=>order,loseResponse:()=>{failAfterCreate=true;}};
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
    // The collected amount is the care fee alone.
    assert.equal(((write.order as Record<string,unknown>).line_items as {base_price_money:{amount:number}}[])[0].base_price_money.amount,9900);
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

test('an issued Square link still reconciles after service suspension, identity correction or changed seller approval',async()=>{
  const s=await setup();try {
    await s.billing.checkout(s.f.owner,s.invoice.id);
    s.f.ledger.setService(s.f.tenant.companyId,false,s.f.now()+86400000,'synthetic-suspension');
    s.f.db.transaction(()=>{
      const old=s.f.ledger.tenant(s.f.tenant.companyId);
      s.f.db.run('UPDATE tenants SET body=? WHERE id=?',canonical({...old,customerName:'Corrected Fictional Agency'}),old.companyId);
      s.f.db.append(old.companyId,'synthetic_customer_identity_corrected',null,s.f.now(),{});
    });
    const changedAdapter=new SquareHostedPaymentAdapter({ledger:s.f.ledger,environment:'sandbox',fetchImpl:s.transport,accessToken:'synthetic-sandbox-token',signatureKey:KEY,notificationUrl:NOTIFY,merchantId:'merchant-a',locationId:'location-a',internalCompanyId:'realbud-internal',expectedSellerBasisDigest:'0'.repeat(64)});
    const resumed=new BillingService(s.f.ledger,changedAdapter,{authorizeCollection:true,internalCompanyId:'realbud-internal'});
    await assert.rejects(resumed.checkout(s.f.owner,s.invoice.id),/commercial_tenant_inactive/);
    const amount=Number(s.invoice.totalCents);
    s.payments.set('late-payment',{id:'late-payment',status:'COMPLETED',source_type:'CARD',location_id:'location-a',order_id:'square-order-one',amount_money:{amount,currency:'AUD'},total_money:{amount,currency:'AUD'},updated_at:new Date(s.f.now()).toISOString()});
    const event=s.signed('payment.updated','late-payment','late-payment-event');
    assert.deepEqual(await resumed.webhook(event.raw,event.signature),{duplicate:false});
    assert.equal(resumed.receipt(s.f.owner,s.invoice.id).amountCents,s.invoice.totalCents);
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

test('self billing and a missing per-tenant mapping cannot create a Square checkout',async()=>{
  const s=await setup();try {
    s.f.ledger.provisionTenant({...s.f.tenant,companyId:'company-b',licenseId:'license-b',customerName:'Fictional Agency B'});
    const closer=new BillingService(s.f.ledger,undefined,{internalCompanyId:'realbud-internal'});
    const ownerB={...s.f.owner,companyId:'company-b'};
    const terms=closer.commercialTerms!.publish(careTermsDraft({tenant:{...s.f.tenant,companyId:'company-b',customerName:'Fictional Agency B'}},'b-v1','5000'));
    closer.commercialTerms!.accept(ownerB,'2026-09','b-v1',terms.digest);
    const unmapped=closer.finalizeCommercialInvoice('company-b','2026-09','b-v1');
    await assert.rejects(s.billing.checkout(ownerB,unmapped.id),/square_mapping_required/);
    assert.throws(()=>recordSquareMapping(s.f.ledger,{companyId:'realbud-internal',merchantId:'merchant-a',locationId:'location-a',customerId:'customer-x',evidence:'never'},'realbud-internal'),/internal_usage_not_billable/);
    recordSquareMapping(s.f.ledger,{companyId:'company-b',merchantId:'merchant-a',locationId:'location-a',customerId:'customer-b',evidence:'synthetic-customer-b-review'});
    assert.throws(()=>recordSquareMapping(s.f.ledger,{companyId:'company-b',merchantId:'merchant-a',locationId:'location-a',customerId:'customer-other',evidence:'synthetic-customer-b-review'}),/square_mapping_conflict/);
    // The other tenant's invoice is never reachable through company-b's principal.
    await assert.rejects(s.billing.checkout(ownerB,s.invoice.id),/invoice_not_found/);
    assert.equal(s.calls.length,0);
    assert.equal(s.f.db.get('SELECT * FROM checkouts WHERE invoice=?',unmapped.id),undefined);
    assert.equal(s.f.db.get('SELECT * FROM checkouts WHERE invoice=?',s.invoice.id),undefined);
    const internal=new SquareHostedPaymentAdapter({ledger:s.f.ledger,environment:'sandbox',fetchImpl:async()=>{throw Error('network must stay off');},accessToken:'fixture',signatureKey:KEY,notificationUrl:NOTIFY,merchantId:'merchant-a',locationId:'location-a',internalCompanyId:s.f.tenant.companyId});
    const billing=new BillingService(s.f.ledger,internal,{authorizeCollection:true});
    await assert.rejects(billing.checkout(s.f.owner,s.invoice.id),/internal_usage_not_collectible/);
    assert.equal(s.calls.length,0);
    assert.equal(s.f.db.get('SELECT * FROM checkouts WHERE invoice=?',s.invoice.id),undefined);
  }finally{s.f.close();}
});

test('production adapter requires an explicit approved seller basis and still refuses a mismatched invoice',async()=>{
  const s=await setup();try {
    const options={ledger:s.f.ledger,environment:'production' as const,fetchImpl:async()=>{throw Error('network must stay off');},accessToken:'synthetic-production-token',signatureKey:KEY,notificationUrl:NOTIFY,merchantId:'merchant-a',locationId:'location-a',internalCompanyId:'realbud-internal'};
    assert.throws(()=>new SquareHostedPaymentAdapter(options),/seller_basis_approval_required/);
    const adapter=new SquareHostedPaymentAdapter({...options,expectedSellerBasisDigest:'0'.repeat(64)});
    assert.throws(()=>adapter.preflightCheckout({companyId:s.f.tenant.companyId,invoiceId:s.invoice.id,amountCents:s.invoice.totalCents}),/seller_basis_not_approved/);
    assert.equal(s.calls.length,0);
  }finally{s.f.close();}
});

test('refund is requested once and the receipt changes only after a completed authenticated Square refund',async()=>{
  const s=await setup();try {
    await s.billing.checkout(s.f.owner,s.invoice.id);
    const amount=Number(s.invoice.totalCents),payment={id:'payment-one',status:'COMPLETED',source_type:'CARD',location_id:'location-a',order_id:'square-order-one',amount_money:{amount,currency:'AUD'},total_money:{amount,currency:'AUD'},updated_at:new Date(s.f.now()).toISOString()};
    s.payments.set('payment-one',payment);
    const paid=s.signed('payment.updated','payment-one','payment-event');await s.billing.webhook(paid.raw,paid.signature);
    s.billing.creditCare(s.f.tenant.companyId,s.invoice.id,'credit-for-refund','1','synthetic-correction');
    const credit=s.f.db.get<{seq:number}>("SELECT seq FROM events WHERE kind='care_credit'")!.seq;
    assert.deepEqual(await s.billing.refundCareCredit(s.f.tenant.companyId,credit,'refund-one'),{refundId:'refund-one',state:'pending_verified_settlement'});
    await assert.rejects(s.billing.refundCareCredit(s.f.tenant.companyId,credit,'refund-two'),/refund_reconciliation_required/);
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

test('one Square webhook URL dispatches payment and refund, and is off without a Square adapter',async()=>{
  const s=await setup();const server=createGatewayServer({billing:s.billing,squareWebhooks:true,allowedOrigins:new Set(),portal:{async authenticate(){return s.f.owner;}}});
  const off=createGatewayServer({billing:new BillingService(s.f.ledger,undefined,{internalCompanyId:'realbud-internal'}),allowedOrigins:new Set(),portal:{async authenticate(){return s.f.owner;}}});
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');off.listen(0,'127.0.0.1');await once(off,'listening');
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bad=await fetch(`${base}/v1/webhooks/square`,{method:'POST',headers:{'x-square-hmacsha256-signature':'bad'},body:'{}'});assert.equal(bad.status,401);
    const event=s.signed('payment.updated','pending-payment','pending-event');
    s.payments.set('pending-payment',{id:'pending-payment',status:'PENDING'});
    const response=await fetch(`${base}/v1/webhooks/square`,{method:'POST',headers:{'x-square-hmacsha256-signature':event.signature},body:event.raw});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ignored:true});
    const unavailable=await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/v1/webhooks/square`,{method:'POST',headers:{'x-square-hmacsha256-signature':event.signature},body:event.raw});
    assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{error:'square_webhook_unavailable'});
  }finally{for(const item of [server,off]){item.closeAllConnections();await new Promise<void>(resolve=>item.close(()=>resolve()));}s.f.close();}
});
