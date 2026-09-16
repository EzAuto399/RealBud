// Synthetic offline reproduction; no request leaves this process.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {fixture} from '../../testing.ts';
import {SquareBilling} from '../../square.ts';
import {digest} from '../../ledger.ts';
const f=fixture(), url='https://fixture.invalid/square', key='fixture-signature-key';
let order:any,invoice:any,payment:any,refund:any;
const transport=async(input:any,options:any)=>{
 const pathname=new URL(String(input)).pathname,body=JSON.parse(options?.body??'{}');
 if(pathname==='/v2/merchants/m')return Response.json({merchant:{id:'m'}});
 if(pathname==='/v2/locations/l')return Response.json({location:{id:'l',merchant_id:'m',status:'ACTIVE',currency:'AUD'}});
 if(pathname==='/v2/orders'){const amount=body.order.line_items[0].base_price_money.amount;order={...body.order,id:'o',total_money:{amount,currency:'AUD'},total_tax_money:{amount:Math.floor((amount+5)/11),currency:'AUD'}};return Response.json({order});}
 if(pathname==='/v2/invoices'){invoice={...body.invoice,id:'i',version:0,status:'DRAFT',payment_requests:[{...body.invoice.payment_requests[0],computed_amount_money:order.total_money}]};return Response.json({invoice});}
 if(pathname==='/v2/invoices/i')return Response.json({invoice});
 if(pathname==='/v2/payments/p')return Response.json({payment});
 if(pathname==='/v2/refunds/r')return Response.json({refund});
 throw Error('Unrecognized synthetic path');
};
const square=new SquareBilling({ledger:f.ledger,fetch:transport,secret:async()=>'fixture-only',signatureKey:async()=>key,notificationUrl:url});
const event=async(type:string,id:string)=>{const raw=Buffer.from(JSON.stringify({event_id:'event-'+id,merchant_id:'m',type,data:{id}}));return square.webhook(raw,createHmac('sha256',key).update(url).update(raw).digest('base64'));};
try{
 await f.run();const request=f.ledger.requests('company-a')[0];
 square.map({companyId:'company-a',merchantId:'m',customerId:'c',locationId:'l',evidence:'fixture'});
 f.setTime(Date.parse('2026-10-15T00:00:00Z'));
 const original=square.closeStatement('company-a','2026-09');square.accept(f.owner,original.id,digest(original));await square.createDraft(f.owner,original.id,'2026-10-30');
 payment={id:'p',status:'COMPLETED',location_id:'l',order_id:'o',customer_id:'c',source_type:'CARD',total_money:{amount:original.totalCents,currency:'AUD'},updated_at:'2026-10-15T00:00:00Z'};await event('payment.updated','p');
 f.ledger.credit(request.id,'credit','10000000','fixture-source-credit');
 f.setTime(Date.parse('2026-11-15T00:00:00Z'));
 const next=square.closeStatement('company-a','2026-10','fictional-care-agreement');
 refund={id:'r',payment_id:'p',status:'COMPLETED',location_id:'l',amount_money:{amount:original.totalCents,currency:'AUD'},updated_at:'2026-11-15T00:00:00Z'};await event('refund.updated','r');
 const money=square.paymentSummary(f.owner,original.id);
 const result={fixtureOnly:true,originalBillCents:original.totalCents,creditAlreadyAppliedNanoAud:next.creditNanoAud,laterFullRefundCents:money.refundedCents,nextStatementTotalCents:next.totalCents,netReceivedCents:money.netReceivedCents,reconciliationRequired:Object.hasOwn(money,'reconciliationRequired')?money.reconciliationRequired:false};
 console.log(JSON.stringify(result,null,2));
 assert.equal(next.creditNanoAud,'10000000');assert.equal(money.refundedCents,original.totalCents);assert.equal(result.reconciliationRequired,true);assert.equal(next.totalCents,12499);assert.deepEqual(square.statement(f.owner,next.id),next);
}finally{f.close();}
