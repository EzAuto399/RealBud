import { createHmac, timingSafeEqual } from 'node:crypto';
import { exact, object, requireThat } from './contracts.ts';
import type { CheckoutRequest, HostedPaymentAdapter, VerifiedPayment, VerifiedRefund, RefundRequest } from './billing.ts';

/** Inspectable local hosted-checkout simulator. Makes no network calls and never takes money.
 * Its webhook signing key is created in-memory by the local harness, never shipped to clients.
 * A selected payment provider must implement its own signature and settlement semantics. */
export class LocalPaymentAdapter implements HostedPaymentAdapter {
  readonly id='local-simulation'; readonly mode='local' as const;
  private readonly key:Uint8Array; private readonly now:()=>number;
  constructor(key:Uint8Array,now:()=>number=Date.now) { requireThat(key.byteLength>=32,'webhook_key_required'); this.key=key; this.now=now; }
  async createCheckout(request:CheckoutRequest) {
    return {sessionId:`local-${request.attemptId}`,url:`https://checkout.invalid/local/${encodeURIComponent(request.attemptId)}`,expiresAt:this.now()+1_800_000};
  }
  private authenticate(raw:Uint8Array,signature:string,now:number):Record<string,unknown> {
    const match=/^t=(\d{13}),v1=([a-f0-9]{64})$/.exec(signature); requireThat(match,'invalid_webhook_signature',401);
    const timestamp=Number(match[1]); requireThat(Math.abs(now-timestamp)<=300_000,'stale_webhook',401);
    const expected=createHmac('sha256',this.key).update(`${timestamp}.`).update(raw).digest();
    requireThat(timingSafeEqual(expected,Buffer.from(match[2],'hex')),'invalid_webhook_signature',401);
    let data:unknown; try { data=JSON.parse(Buffer.from(raw).toString('utf8')); } catch { requireThat(false,'invalid_webhook',400); }
    object(data); requireThat(data.mode==='local','wrong_payment_environment',403); return data;
  }
  async verifyWebhook(raw:Uint8Array,signature:string,now:number):Promise<VerifiedPayment|null> {
    const data=this.authenticate(raw,signature,now); exact(data,['mode','status','payment']);
    if(data.status==='pending' || data.status==='failed') return null;
    requireThat(data.status==='settled','unsupported_payment_event'); object(data.payment);
    exact(data.payment,['eventId','transactionId','invoiceId','attemptId','sessionId','amountCents','currency','settledAt']);
    return data.payment as unknown as VerifiedPayment;
  }
  async requestRefund(_request:RefundRequest):Promise<void> { /* Local simulation only; does not mark a refund paid. */ }
  async verifyRefundWebhook(raw:Uint8Array,signature:string,now:number):Promise<VerifiedRefund|null> {
    const data=this.authenticate(raw,signature,now); exact(data,['mode','status','refund']);
    if(data.status==='pending' || data.status==='failed') return null;
    requireThat(data.status==='settled','unsupported_refund_event'); object(data.refund);
    exact(data.refund,['eventId','refundId','providerRefundId','transactionId','amountCents','currency','settledAt']);
    return data.refund as unknown as VerifiedRefund;
  }
}
