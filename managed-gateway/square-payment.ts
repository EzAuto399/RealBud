/** Square-hosted collection for already closed care invoices.
 * The signed webhook is only a trigger: Square GETs and the durable checkout
 * intent are the evidence used to project settlement. No browser return is. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { abortable } from './abort.ts';
import { canonical, id, object, requireThat } from './contracts.ts';
import type { CheckoutRequest, HostedCheckout, HostedPaymentAdapter, Invoice, RefundRequest, VerifiedPayment, VerifiedRefund } from './billing.ts';
import type { UsageLedger } from './ledger.ts';
import type { SquareEnvironment, SquareMapping as Mapping } from './square-mapping.ts';
import { CommercialTermsStore } from './commercial-terms.ts';

const HOSTS:Record<SquareEnvironment,string>={production:'https://connect.squareup.com',sandbox:'https://connect.squareupsandbox.com'};
const VERSION='2026-08-19';
const EVENT_MAX_AGE_MS=7*24*60*60*1000; // Square may retry delivery; not a browser-session timeout.
type SavedCheckout={attemptId:string;amountCents:string;provider:string;session?:HostedCheckout};
type SquareEvent={event_id:string;merchant_id:string;type:string;created_at:string;data:{type:string;id:string;object?:Record<string,unknown>}};
const hash=(...parts:string[])=>createHash('sha256').update(canonical(parts)).digest('hex');
const money=(value:unknown)=>{object(value);requireThat(value.currency==='AUD' && Number.isSafeInteger(value.amount) && Number(value.amount)>0,'square_money_mismatch',409);return Number(value.amount);};
const timestamp=(value:unknown)=>{requireThat(typeof value==='string','square_timestamp_invalid',409);const result=Date.parse(value);requireThat(Number.isSafeInteger(result) && result>0,'square_timestamp_invalid',409);return result;};

export class SquareHostedPaymentAdapter implements HostedPaymentAdapter {
  readonly id:string;readonly mode:'sandbox'|'live';
  private readonly host:string;
  private readonly ledger:UsageLedger;
  private readonly transport:typeof fetch;
  private readonly accessToken:string;
  private readonly signatureKey:string;
  private readonly notificationUrl:string;
  private readonly merchantId:string;
  private readonly locationId:string;
  private readonly internalCompanyId:string;
  private readonly terms:CommercialTermsStore;
  private readonly expectedSellerBasisDigest:string|undefined;
  constructor(options:{ledger:UsageLedger;environment:SquareEnvironment;fetchImpl?:typeof fetch;accessToken:string;signatureKey:string;notificationUrl:string;merchantId:string;locationId:string;internalCompanyId:string;expectedSellerBasisDigest?:string}) {
    requireThat(options.environment==='sandbox'||options.environment==='production','square_environment_invalid');
    this.ledger=options.ledger;this.host=HOSTS[options.environment];this.mode=options.environment==='sandbox'?'sandbox':'live';this.id=`square-${this.mode}`;
    this.transport=options.fetchImpl??fetch;this.accessToken=options.accessToken;this.signatureKey=options.signatureKey;
    this.notificationUrl=options.notificationUrl;this.merchantId=options.merchantId;this.locationId=options.locationId;this.internalCompanyId=options.internalCompanyId;
    this.terms=new CommercialTermsStore(options.ledger,options.internalCompanyId);
    this.expectedSellerBasisDigest=options.expectedSellerBasisDigest;
    [this.merchantId,this.locationId,this.internalCompanyId].forEach(id);
    requireThat(this.accessToken.length>0 && this.signatureKey.length>0,'square_credentials_required',503);
    if(this.mode==='live') requireThat(typeof this.expectedSellerBasisDigest==='string' && /^[a-f0-9]{64}$/.test(this.expectedSellerBasisDigest),'seller_basis_approval_required',503);
    const notify=new URL(this.notificationUrl);
    requireThat(notify.protocol==='https:' && !notify.username && !notify.password && !notify.search && !notify.hash && notify.pathname==='/v1/webhooks/square','square_notification_url_invalid',503);
  }
  private async request(method:'GET'|'POST',path:string,payload?:unknown):Promise<Record<string,unknown>> {
    const signal=AbortSignal.timeout(10_000);
    const response=await abortable(this.transport(`${this.host}${path}`,{method,redirect:'error',signal,headers:{Authorization:`Bearer ${this.accessToken}`,'Square-Version':VERSION,'Content-Type':'application/json'},...(payload===undefined?{}:{body:canonical(payload)})}),signal);
    if(!response.ok){void response.body?.cancel().catch(()=>{});requireThat(false,'square_request_failed',502);}
    requireThat(response.body,'invalid_square_response',502);
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try {while(true){const next=await abortable(reader.read(),signal);if(next.done)break;size+=next.value.byteLength;requireThat(size<=1_000_000,'square_response_too_large',502);chunks.push(next.value);}}finally{void reader.cancel().catch(()=>{});}
    let parsed:unknown;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{requireThat(false,'invalid_square_response',502);}
    object(parsed);requireThat(!parsed.errors,'square_api_error',502);return parsed;
  }
  private mapping(companyId:string):Mapping {
    id(companyId);requireThat(companyId!==this.internalCompanyId,'internal_usage_not_collectible',403);
    this.ledger.tenant(companyId);
    const row=this.ledger.db.get<{body:string}>('SELECT body FROM square_mappings WHERE tenant=?',companyId);
    requireThat(row,'square_mapping_required',409);
    const mapping=JSON.parse(row.body) as Mapping;
    requireThat(mapping.companyId===companyId && mapping.merchantId===this.merchantId && mapping.locationId===this.locationId && mapping.customerId && mapping.evidence,'square_mapping_mismatch',403);
    return mapping;
  }
  private async seller():Promise<void> {
    const merchant=await this.request('GET',`/v2/merchants/${encodeURIComponent(this.merchantId)}`);object(merchant.merchant);
    requireThat(merchant.merchant.id===this.merchantId && merchant.merchant.status==='ACTIVE' && merchant.merchant.country==='AU' && merchant.merchant.currency==='AUD','square_merchant_mismatch',403);
    const location=await this.request('GET',`/v2/locations/${encodeURIComponent(this.locationId)}`);object(location.location);
    requireThat(location.location.id===this.locationId && location.location.merchant_id===this.merchantId && location.location.status==='ACTIVE' && location.location.currency==='AUD','square_location_mismatch',403);
  }
  private reference(companyId:string,invoiceId:string,attemptId:string,invoiceDigest:string,termsDigest:string):string {return `rb-${hash(companyId,invoiceId,attemptId,invoiceDigest,termsDigest).slice(0,37)}`;}
  private checkoutForReference(reference:string) {
    const rows=this.ledger.db.all<{invoice:string;state:string;body:string;tenant:string;invoice_body:string}>(`SELECT c.invoice,c.state,c.body,i.tenant,i.body AS invoice_body FROM checkouts c JOIN invoices i ON i.id=c.invoice`);
    const matches=rows.filter(row=>{const data=JSON.parse(row.body) as SavedCheckout;if(data.provider!==this.id)return false;
      const binding=this.ledger.db.get<{invoice_digest:string;terms_digest:string}>('SELECT invoice_digest,terms_digest FROM collection_invoice_bindings WHERE invoice=? AND tenant=?',row.invoice,row.tenant);
      return !!binding && this.reference(row.tenant,row.invoice,data.attemptId,binding.invoice_digest,binding.terms_digest)===reference;});
    requireThat(matches.length===1,'square_checkout_reconciliation_required',409);
    const row=matches[0],saved=JSON.parse(row.body) as SavedCheckout,invoice=JSON.parse(row.invoice_body) as Invoice;
    this.mapping(row.tenant);
    this.terms.assertCollectible(invoice,undefined,false);
    requireThat(invoice.companyId===row.tenant && invoice.id===row.invoice && saved.amountCents===invoice.totalCents,'square_checkout_binding_mismatch',409);
    return {row,saved,invoice};
  }
  private async order(orderId:string):Promise<Record<string,unknown>> {
    id(orderId);const response=await this.request('GET',`/v2/orders/${encodeURIComponent(orderId)}`);object(response.order);return response.order;
  }
  private checkOrder(order:Record<string,unknown>,orderId:string,reference:string,amountCents:string,gstCents:string) {
    requireThat(order.id===orderId && order.location_id===this.locationId && order.reference_id===reference && money(order.total_money)===Number(amountCents),'square_order_mismatch',409);
    // The local invoice is the tax document. Square's inclusive GST line must
    // nevertheless show the same tax to avoid conflicting buyer-facing totals.
    object(order.total_tax_money);requireThat(order.total_tax_money.currency==='AUD' && order.total_tax_money.amount===Number(gstCents),'square_order_tax_mismatch',409);
  }
  private checkoutUrl(value:unknown):string {
    requireThat(typeof value==='string','invalid_square_checkout_url',502);
    const url=new URL(value);
    const production=['square.link','checkout.square.site'];
    const sandbox=['connect.squareupsandbox.com','squareupsandbox.com'];
    requireThat(url.protocol==='https:' && !url.username && !url.password && (this.mode==='sandbox'?sandbox:production).includes(url.hostname),'invalid_square_checkout_url',502);
    return value;
  }
  preflightCheckout(request:Pick<CheckoutRequest,'companyId'|'invoiceId'|'amountCents'>):void {
    this.mapping(request.companyId);
    const row=this.ledger.db.get<{tenant:string;body:string}>('SELECT tenant,body FROM invoices WHERE id=?',request.invoiceId);
    requireThat(row?.tenant===request.companyId,'square_checkout_binding_mismatch',409);
    const invoice=JSON.parse(row.body) as Invoice;
    requireThat(invoice.companyId===request.companyId && invoice.id===request.invoiceId && invoice.kind==='Tax Invoice' && invoice.currency==='AUD' && invoice.totalCents===request.amountCents,'square_checkout_binding_mismatch',409);
    this.terms.assertCollectible(invoice,this.expectedSellerBasisDigest);
  }
  async createCheckout(request:CheckoutRequest):Promise<HostedCheckout> {
    [request.companyId,request.invoiceId,request.attemptId,request.idempotencyKey].forEach(id);
    requireThat(request.currency==='AUD' && /^[1-9][0-9]{0,14}$/.test(request.amountCents),'invalid_checkout_amount');
    this.preflightCheckout(request);
    const row=this.ledger.db.get<{tenant:string;body:string;state:string;checkout_body:string}>(`SELECT i.tenant,i.body,c.state,c.body AS checkout_body FROM invoices i JOIN checkouts c ON c.invoice=i.id WHERE i.id=?`,request.invoiceId);
    requireThat(row && row.tenant===request.companyId && row.state==='creating','square_checkout_binding_mismatch',409);
    const invoice=JSON.parse(row.body) as Invoice,saved=JSON.parse(row.checkout_body) as SavedCheckout;
    requireThat(invoice.companyId===request.companyId && invoice.id===request.invoiceId && invoice.kind==='Tax Invoice' && invoice.currency==='AUD' && saved.provider===this.id && saved.attemptId===request.attemptId && saved.amountCents===request.amountCents && invoice.totalCents===request.amountCents,'square_checkout_binding_mismatch',409);
    await this.seller();
    const binding=this.terms.assertCollectible(invoice,this.expectedSellerBasisDigest);
    const reference=this.reference(request.companyId,request.invoiceId,request.attemptId,binding.invoiceDigest,binding.termsDigest);
    const response=await this.request('POST','/v2/online-checkout/payment-links',{
      idempotency_key:request.idempotencyKey,
      description:`RealBud invoice ${request.invoiceId}`,
      payment_note:`RealBud invoice ${request.invoiceId}`,
      order:{location_id:this.locationId,reference_id:reference,line_items:[{name:`RealBud invoice ${request.invoiceId}`,quantity:'1',base_price_money:{amount:Number(request.amountCents),currency:'AUD'}}],taxes:[{uid:'gst',name:'GST',percentage:'10',type:'INCLUSIVE',scope:'ORDER'}]},
      checkout_options:{allow_tipping:false,enable_coupon:false,enable_loyalty:false,
        accepted_payment_methods:{apple_pay:false,google_pay:false,cash_app_pay:false,afterpay_clearpay:false}},
    });
    object(response.payment_link);id(response.payment_link.id);id(response.payment_link.order_id);
    const url=this.checkoutUrl(response.payment_link.url);
    const order=await this.order(response.payment_link.order_id);
    this.checkOrder(order,response.payment_link.order_id,reference,request.amountCents,invoice.gstCents);
    // Square does not promise link expiry. This is only our reuse cutoff; an
    // already issued link remains subject to signed settlement reconciliation.
    return {sessionId:response.payment_link.order_id,url,expiresAt:this.ledger.now()+30*24*60*60*1000};
  }
  private authenticate(raw:Uint8Array,signature:string,now:number):SquareEvent {
    requireThat(raw.byteLength<=256_000 && /^[A-Za-z0-9+/]{43}=$/.test(signature),'invalid_square_signature',401);
    const expected=createHmac('sha256',this.signatureKey).update(this.notificationUrl).update(raw).digest();
    const supplied=Buffer.from(signature,'base64');requireThat(supplied.byteLength===expected.byteLength && timingSafeEqual(expected,supplied),'invalid_square_signature',401);
    let parsed:unknown;try{parsed=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{requireThat(false,'invalid_square_event');}
    object(parsed);[parsed.event_id,parsed.merchant_id].forEach(id);requireThat(parsed.merchant_id===this.merchantId,'square_merchant_mismatch',403);
    const created=timestamp(parsed.created_at);requireThat(created<=now+300_000 && now-created<=EVENT_MAX_AGE_MS,'stale_square_event',401);
    object(parsed.data);id(parsed.data.id);requireThat(typeof parsed.type==='string' && typeof parsed.data.type==='string','invalid_square_event');
    return parsed as SquareEvent;
  }
  async verifyWebhook(raw:Uint8Array,signature:string,now:number):Promise<VerifiedPayment|null> {
    const event=this.authenticate(raw,signature,now);
    if(!['payment.created','payment.updated'].includes(event.type))return null;
    requireThat(event.data.type==='payment' && (!event.data.object || (event.data.object.payment as Record<string,unknown>)?.id===event.data.id),'square_event_binding_mismatch',409);
    const response=await this.request('GET',`/v2/payments/${encodeURIComponent(event.data.id)}`);object(response.payment);const payment=response.payment;
    requireThat(payment.id===event.data.id,'square_payment_id_mismatch',409);
    if(payment.status!=='COMPLETED')return null;
    id(payment.order_id);requireThat(payment.location_id===this.locationId && ['CARD','WALLET'].includes(String(payment.source_type)),'square_payment_scope_mismatch',403);
    const order=await this.order(payment.order_id);requireThat(typeof order.reference_id==='string','square_order_reference_missing',409);
    if(!order.reference_id.startsWith('rb-'))return null; // Other seller activity in the same Square account.
    const {row,saved,invoice}=this.checkoutForReference(order.reference_id);
    this.checkOrder(order,payment.order_id,order.reference_id,saved.amountCents,invoice.gstCents);
    requireThat(!saved.session || saved.session.sessionId===payment.order_id,'square_checkout_binding_mismatch',409);
    requireThat(money(payment.total_money)===Number(saved.amountCents) && money(payment.amount_money)===Number(saved.amountCents),'square_payment_amount_mismatch',409);
    const settledAt=timestamp(payment.updated_at);requireThat(settledAt<=now,'square_settlement_future',409);
    return {eventId:event.event_id,transactionId:event.data.id,invoiceId:row.invoice,attemptId:saved.attemptId,sessionId:payment.order_id,amountCents:saved.amountCents,currency:'AUD',settledAt};
  }
  async requestRefund(request:RefundRequest):Promise<void> {
    [request.refundId,request.transactionId,request.idempotencyKey].forEach(id);
    requireThat(request.currency==='AUD' && /^[1-9][0-9]{0,14}$/.test(request.amountCents),'invalid_refund_amount');
    const intent=this.ledger.db.get<{tenant:string;body:string;payment:string}>('SELECT tenant,body,payment FROM refund_intents WHERE id=?',request.refundId);
    requireThat(intent && intent.body===canonical(request) && intent.payment===`${this.id}:${request.transactionId}`,'square_refund_intent_mismatch',409);
    this.mapping(intent.tenant);
    const paid=this.ledger.db.get<{invoice:string;body:string}>('SELECT invoice,body FROM payments WHERE id=?',intent.payment);
    requireThat(paid,'payment_not_settled',409);
    const invoiceRow=this.ledger.db.get<{tenant:string}>('SELECT tenant FROM invoices WHERE id=?',paid.invoice);
    requireThat(invoiceRow?.tenant===intent.tenant,'square_refund_tenant_mismatch',409);
    const originalInvoice=this.ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',paid.invoice);
    requireThat(originalInvoice,'square_refund_invoice_missing',409);
    this.terms.assertCollectible(JSON.parse(originalInvoice.body) as Invoice,undefined,false);
    const original=JSON.parse(paid.body) as VerifiedPayment;
    requireThat(original.transactionId===request.transactionId && BigInt(request.amountCents)<=BigInt(original.amountCents),'square_refund_scope_mismatch',409);
    const response=await this.request('GET',`/v2/payments/${encodeURIComponent(request.transactionId)}`);object(response.payment);
    requireThat(response.payment.id===request.transactionId && response.payment.status==='COMPLETED' && response.payment.location_id===this.locationId && response.payment.order_id===original.sessionId,'square_refund_scope_mismatch',409);
    await this.request('POST','/v2/refunds',{idempotency_key:hash(request.idempotencyKey).slice(0,40),payment_id:request.transactionId,amount_money:{amount:Number(request.amountCents),currency:'AUD'},reason:`RealBud credit ${request.refundId}`});
    // POST success can still mean PENDING. Only the authenticated refund.updated
    // plus GET COMPLETED advances the local receipt.
  }
  async verifyRefundWebhook(raw:Uint8Array,signature:string,now:number):Promise<VerifiedRefund|null> {
    const event=this.authenticate(raw,signature,now);
    if(!['refund.created','refund.updated'].includes(event.type))return null;
    requireThat(event.data.type==='refund' && (!event.data.object || (event.data.object.refund as Record<string,unknown>)?.id===event.data.id),'square_event_binding_mismatch',409);
    const response=await this.request('GET',`/v2/refunds/${encodeURIComponent(event.data.id)}`);object(response.refund);const refund=response.refund;
    requireThat(refund.id===event.data.id,'square_refund_id_mismatch',409);
    if(refund.status!=='COMPLETED')return null;
    id(refund.payment_id);requireThat(refund.unlinked!==true && refund.location_id===this.locationId,'square_refund_scope_mismatch',403);
    if(typeof refund.reason!=='string'||!refund.reason.startsWith('RealBud credit '))return null;
    const refundId=refund.reason.slice('RealBud credit '.length);id(refundId);
    const intent=this.ledger.db.get<{tenant:string;payment:string;body:string}>('SELECT tenant,payment,body FROM refund_intents WHERE id=?',refundId);
    requireThat(intent && intent.payment===`${this.id}:${refund.payment_id}`,'square_refund_intent_mismatch',409);
    this.mapping(intent.tenant);
    const original=JSON.parse(intent.body) as RefundRequest;
    requireThat(original.transactionId===refund.payment_id && money(refund.amount_money)===Number(original.amountCents),'square_refund_amount_mismatch',409);
    const paid=this.ledger.db.get<{invoice:string;body:string}>('SELECT invoice,body FROM payments WHERE id=?',intent.payment);
    requireThat(paid,'square_refund_payment_missing',409);
    const invoiceRow=this.ledger.db.get<{tenant:string}>('SELECT tenant FROM invoices WHERE id=?',paid.invoice);
    requireThat(invoiceRow?.tenant===intent.tenant,'square_refund_tenant_mismatch',409);
    const originalPayment=JSON.parse(paid.body) as VerifiedPayment;
    const paymentResponse=await this.request('GET',`/v2/payments/${encodeURIComponent(refund.payment_id)}`);object(paymentResponse.payment);
    requireThat(paymentResponse.payment.id===refund.payment_id && paymentResponse.payment.status==='COMPLETED' && paymentResponse.payment.location_id===this.locationId && paymentResponse.payment.order_id===originalPayment.sessionId,'square_refund_payment_mismatch',409);
    const settledAt=timestamp(refund.updated_at);requireThat(settledAt<=now,'square_settlement_future',409);
    return {eventId:event.event_id,refundId,providerRefundId:event.data.id,transactionId:refund.payment_id,amountCents:original.amountCents,currency:'AUD',settledAt};
  }
}
