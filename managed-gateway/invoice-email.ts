/** Delivery of the one office-facing RealBud invoice. Closing writes the outbox
 * intent atomically with the immutable invoice; network I/O happens afterward.
 * A timeout is ambiguous, so every retry reuses the frozen Resend request and
 * key, and stops well before Resend's 24-hour idempotency retention ends. */
import { createHash, randomUUID } from 'node:crypto';
import { canonical, id, requireThat } from './contracts.ts';
import { digest, type UsageLedger } from './ledger.ts';
import { validBillingEmail } from './commercial-terms.ts';
import { invoiceHtml } from './invoice-html.ts';
import type { Invoice, BillingService } from './billing.ts';

export type InvoiceEmailState='queued'|'sending'|'retryable'|'provider_accepted'|'rejected'|'reconciliation_required';
export interface InvoiceEmailPayload { from:string; to:[string]; subject:string; html:string }
export interface InvoiceEmailTransport {
  /** Stable identity of the sending account/key; never the key itself. */
  identity:string;
  sender:string;
  /** Exact frozen JSON bytes are supplied on every attempt. */
  send(payloadJson:string,idempotencyKey:string):Promise<{id:string}>;
}
interface PreparedEmail { payloadJson:string; idempotencyKey:string; transportIdentity:string; firstAttemptAt:number; lastAttemptAt:number; leaseUntil:number; attempts:number }
interface Outbox { invoiceId:string; companyId:string; invoiceDigest:string; termsDigest:string; recipient:string; state:InvoiceEmailState;
  queuedAt?:number;manualOnly?:boolean;nextIdempotencyKey?:string;repairCount?:number;everAmbiguous?:boolean;
  prepared?:PreparedEmail;providerMessageId?:string;failureCode?:string }
interface OutboxRow { state:InvoiceEmailState; body:string }
export interface InvoiceEmailStatus { invoiceId:string; state:InvoiceEmailState|'not_queued'; providerMessageId?:string; failureCode?:string; attempts?:number;manualReviewRequired?:true }

const LEASE_MS=60_000;
const RETRY_DELAY_MS=60_000;
/** Four hours of margin before Resend's documented 24-hour key expiry. */
const RETRY_WINDOW_MS=20*60*60_000;
const MAX_ATTEMPTS=8;
const QUEUED_AUTO_WINDOW_MS=60*60_000;
const MAX_DRAIN_BATCH=8;
const ACCOUNT_ORIGIN='https://realbud.app';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

function status(value:Outbox,now:number):InvoiceEmailStatus {
  return {invoiceId:value.invoiceId,state:value.state,...(value.providerMessageId?{providerMessageId:value.providerMessageId}:{}),
    ...(value.failureCode?{failureCode:value.failureCode}:{}),...(value.prepared?{attempts:value.prepared.attempts}:{}),
    ...(value.state==='queued' && (value.manualOnly || value.queuedAt===undefined || now-value.queuedAt>=QUEUED_AUTO_WINDOW_MS)?{manualReviewRequired:true as const}:{})};
}
function getOutbox(ledger:UsageLedger,companyId:string,invoiceId:string):Outbox|undefined {
  const row=ledger.db.get<OutboxRow>('SELECT state,body FROM invoice_email_outbox WHERE tenant=? AND invoice=?',companyId,invoiceId);
  if(!row) return undefined;
  const value=JSON.parse(row.body) as Outbox;
  requireThat(row.state===value.state && value.companyId===companyId && value.invoiceId===invoiceId,'invoice_email_outbox_corrupt',503);
  return value;
}
function putOutbox(ledger:UsageLedger,value:Outbox) {
  ledger.db.run('UPDATE invoice_email_outbox SET state=?,body=? WHERE invoice=? AND tenant=?',value.state,canonical(value),value.invoiceId,value.companyId);
}

/** Called only inside the fresh invoice-close transaction. Legacy closes have
 * no recipient and therefore no outbox row or digest change. */
export function queueInvoiceEmail(ledger:UsageLedger,invoice:Invoice,recipient:string|undefined,termsDigest:string):void {
  if(recipient===undefined) return;
  requireThat(validBillingEmail(recipient) && invoice.customer.billingEmail===recipient && invoice.commercialTerms?.digest===termsDigest,'invoice_email_recipient_mismatch',409);
  const value:Outbox={invoiceId:invoice.id,companyId:invoice.companyId,invoiceDigest:digest(invoice),termsDigest,recipient,state:'queued',queuedAt:ledger.now()};
  ledger.db.run('INSERT INTO invoice_email_outbox(invoice,tenant,state,body) VALUES(?,?,?,?)',invoice.id,invoice.companyId,value.state,canonical(value));
  ledger.db.append(invoice.companyId,'invoice_email_queued',null,ledger.now(),{invoiceId:invoice.id,invoiceDigest:value.invoiceDigest,termsDigest,recipientDigest:hash(recipient)});
}

/** Tenant-scoped readback; an existing invoice without an outbox is never
 * backfilled automatically. CLI output deliberately omits the recipient. */
export function invoiceEmailStatus(billing:BillingService,companyId:string,invoiceId:string):InvoiceEmailStatus {
  id(companyId);id(invoiceId);
  requireThat(billing.ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND id=?',companyId,invoiceId),'invoice_not_found',404);
  const value=getOutbox(billing.ledger,companyId,invoiceId);
  return value?status(value,billing.ledger.now()):{invoiceId,state:'not_queued'};
}

function assertBinding(billing:BillingService,value:Outbox):Invoice {
  const row=billing.ledger.db.get<{body:string}>('SELECT body FROM invoices WHERE tenant=? AND id=?',value.companyId,value.invoiceId);
  requireThat(row,'invoice_not_found',404);
  const invoice=JSON.parse(row.body) as Invoice;
  requireThat(invoice.mode==='commercial' && digest(invoice)===value.invoiceDigest && invoice.customer.billingEmail===value.recipient && invoice.commercialTerms?.digest===value.termsDigest,'invoice_email_binding_mismatch',503);
  const accepted=billing.commercialTerms?.accepted(value.companyId,invoice.period,invoice.commercialTerms.version,false);
  requireThat(accepted && accepted.digest===value.termsDigest && accepted.terms.customer.billingEmail===value.recipient,'invoice_email_binding_mismatch',503);
  return invoice;
}
function payload(invoice:Invoice,sender:string,recipient:string):InvoiceEmailPayload {
  requireThat(validBillingEmail(sender),'invoice_email_sender_invalid',503);
  // The document itself is the email body. The invoice's optional CSV link is
  // absolute here, since email clients have no RealBud page origin to resolve it.
  const html=invoiceHtml(invoice).replaceAll('href="/api/account/','href="'+ACCOUNT_ORIGIN+'/api/account/');
  return {from:sender,to:[recipient],subject:`RealBud ${invoice.kind} ${invoice.id} — ${invoice.period}`,html};
}

/** Claims one invoice under SQLite BEGIN IMMEDIATE before calling the provider.
 * Concurrent workers either observe a live lease or use the same frozen key. */
export async function deliverInvoiceEmail(billing:BillingService,companyId:string,invoiceId:string,transport:InvoiceEmailTransport|undefined):Promise<InvoiceEmailStatus> {
  const ledger=billing.ledger;
  const known=invoiceEmailStatus(billing,companyId,invoiceId);
  if(known.state==='not_queued' || !transport) return known;
  requireThat(typeof transport.identity==='string' && transport.identity.length>0 && validBillingEmail(transport.sender),'invoice_email_transport_invalid',503);
  const claim=ledger.db.transaction(()=>{
    const value=getOutbox(ledger,companyId,invoiceId)!;
    const invoice=assertBinding(billing,value);
    if(value.state==='provider_accepted' || value.state==='rejected' || value.state==='reconciliation_required') return {send:false,value};
    const now=ledger.now();
    if(value.prepared) {
      if(value.prepared.transportIdentity!==transport.identity) {
        value.state='reconciliation_required';value.failureCode='transport_identity_changed';putOutbox(ledger,value);
        ledger.db.append(companyId,'invoice_email_reconciliation_required',null,now,{invoiceId,failureCode:value.failureCode});
        return {send:false,value};
      }
      if(now<value.prepared.firstAttemptAt || now-value.prepared.firstAttemptAt>=RETRY_WINDOW_MS || value.prepared.attempts>=MAX_ATTEMPTS) {
        value.state='reconciliation_required';value.failureCode='retry_window_or_attempts_exhausted';putOutbox(ledger,value);
        ledger.db.append(companyId,'invoice_email_reconciliation_required',null,now,{invoiceId,failureCode:value.failureCode});
        return {send:false,value};
      }
      if(value.state==='sending' && now<value.prepared.leaseUntil) return {send:false,value};
      if(value.state==='retryable' && now-value.prepared.lastAttemptAt<RETRY_DELAY_MS) return {send:false,value};
      if(value.state==='sending') value.everAmbiguous=true;
      value.prepared.lastAttemptAt=now;value.prepared.leaseUntil=now+LEASE_MS;value.prepared.attempts++;
    } else {
      const idempotencyKey=value.nextIdempotencyKey??`realbud-invoice-${invoice.id}-${value.invoiceDigest.slice(0,32)}`;
      value.prepared={payloadJson:JSON.stringify(payload(invoice,transport.sender,value.recipient)),idempotencyKey,transportIdentity:transport.identity,firstAttemptAt:now,lastAttemptAt:now,leaseUntil:now+LEASE_MS,attempts:1};
      delete value.nextIdempotencyKey;
    }
    value.state='sending';delete value.failureCode;delete value.manualOnly;putOutbox(ledger,value);
    ledger.db.append(companyId,'invoice_email_attempted',null,now,{invoiceId,invoiceDigest:value.invoiceDigest,attempt:value.prepared.attempts,idempotencyKey:value.prepared.idempotencyKey});
    return {send:true,value};
  });
  if(!claim.send) return status(claim.value,ledger.now());
  const prepared=claim.value.prepared!;
  let outcome:{kind:'accepted';id:string}|{kind:'retryable'|'rejected'|'reconciliation_required';code:string};
  try {
    const response=await transport.send(prepared.payloadJson,prepared.idempotencyKey);
    requireThat(typeof response.id==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(response.id),'invoice_email_provider_response_invalid',503);
    outcome={kind:'accepted',id:response.id};
  } catch(error) {
    outcome=error instanceof InvoiceEmailTransportError
      ?{kind:error.kind,code:error.code}
      :{kind:'retryable',code:'remote_outcome_unknown'};
  }
  return ledger.db.transaction(()=>{
    const value=getOutbox(ledger,companyId,invoiceId)!;
    if(value.state==='provider_accepted') return status(value,ledger.now());
    requireThat(value.prepared?.idempotencyKey===prepared.idempotencyKey && value.prepared.payloadJson===prepared.payloadJson,'invoice_email_outbox_corrupt',503);
    // An older timed-out worker must not replace the newer worker's live lease
    // with its failure. A late success is still useful provider acceptance.
    if(outcome.kind!=='accepted' && value.prepared.attempts!==prepared.attempts) return status(value,ledger.now());
    if(outcome.kind==='accepted') {value.state='provider_accepted';value.providerMessageId=outcome.id;delete value.failureCode;}
    else {value.state=outcome.kind;value.failureCode=outcome.code;if(outcome.kind==='retryable') value.everAmbiguous=true;}
    putOutbox(ledger,value);
    ledger.db.append(companyId,outcome.kind==='accepted'?'invoice_email_provider_accepted':'invoice_email_attempt_failed',null,ledger.now(),
      {invoiceId,state:value.state,...(outcome.kind==='accepted'?{providerMessageId:outcome.id}:{failureCode:outcome.code})});
    return status(value,ledger.now());
  });
}

/** Server sweep: only very recent never-attempted rows can send automatically.
 * Older queued rows stay visible for an operator's explicit `email-deliver`.
 * Retried rows keep their original key and the claim enforces lease/expiry. */
export async function drainInvoiceEmails(billing:BillingService,transport:InvoiceEmailTransport,limit=MAX_DRAIN_BATCH):Promise<{scanned:number;accepted:number;nonaccepted:number;reconciliationRequired:number;rejected:number;retryable:number;errors:number}> {
  requireThat(Number.isSafeInteger(limit) && limit>=1 && limit<=MAX_DRAIN_BATCH,'invoice_email_drain_limit_invalid',503);
  const now=billing.ledger.now();
  const rows=billing.ledger.db.all<{invoice:string;tenant:string}>(`SELECT invoice,tenant FROM invoice_email_outbox WHERE
    (state='queued' AND json_extract(body,'$.queuedAt') BETWEEN ? AND ? AND COALESCE(json_extract(body,'$.manualOnly'),0)=0)
    OR (state='retryable' AND json_extract(body,'$.prepared.lastAttemptAt')<=?)
    OR (state='sending' AND json_extract(body,'$.prepared.leaseUntil')<=?)
    ORDER BY invoice LIMIT ?`,now-QUEUED_AUTO_WINDOW_MS,now,now-RETRY_DELAY_MS,now,limit);
  const results=await Promise.allSettled(rows.map(row=>deliverInvoiceEmail(billing,row.tenant,row.invoice,transport)));
  const states=results.filter(result=>result.status==='fulfilled').map(result=>result.value.state);
  return {scanned:rows.length,accepted:states.filter(state=>state==='provider_accepted').length,
    nonaccepted:states.filter(state=>state!=='provider_accepted').length,
    reconciliationRequired:states.filter(state=>state==='reconciliation_required').length,
    rejected:states.filter(state=>state==='rejected').length,retryable:states.filter(state=>state==='retryable').length,
    errors:results.filter(result=>result.status==='rejected').length};
}

/** A 401/403 is a definite auth rejection. Only a first, completed rejection
 * with no ambiguous history can be reset, and only by an explicit operator CLI
 * action using corrected configuration. A new key is audited before any send;
 * the repaired row remains manual-only until `email-deliver`. */
export function repairRejectedInvoiceEmail(billing:BillingService,companyId:string,invoiceId:string,transport:InvoiceEmailTransport,operatorSubject:string,reviewReference:string):InvoiceEmailStatus {
  [companyId,invoiceId,operatorSubject,reviewReference].forEach(id);
  requireThat(validBillingEmail(transport.sender) && typeof transport.identity==='string' && transport.identity.length>0,'invoice_email_transport_invalid',503);
  return billing.ledger.db.transaction(()=>{
    const value=getOutbox(billing.ledger,companyId,invoiceId);requireThat(value,'invoice_email_not_queued',409);
    assertBinding(billing,value);
    requireThat(value.state==='rejected' && value.failureCode==='provider_auth_rejected' && value.prepared?.attempts===1 && !value.everAmbiguous,'invoice_email_repair_requires_definite_first_auth_rejection',409);
    const previous=value.prepared;
    const previousSender=(JSON.parse(previous.payloadJson) as InvoiceEmailPayload).from;
    requireThat(transport.identity!==previous.transportIdentity || transport.sender!==previousSender,'invoice_email_repair_configuration_unchanged',409);
    const newIdempotencyKey=`realbud-invoice-${invoiceId}-repair-${randomUUID()}`;
    value.state='queued';value.queuedAt=billing.ledger.now();value.manualOnly=true;value.nextIdempotencyKey=newIdempotencyKey;
    value.repairCount=(value.repairCount??0)+1;delete value.prepared;delete value.failureCode;
    putOutbox(billing.ledger,value);
    billing.ledger.db.append(companyId,'invoice_email_auth_repaired',null,billing.ledger.now(),{invoiceId,operatorSubject,reviewReference,
      previousIdempotencyKey:previous.idempotencyKey,newIdempotencyKey,repairCount:value.repairCount});
    return status(value,billing.ledger.now());
  });
}

export class InvoiceEmailTransportError extends Error {
  readonly kind:'retryable'|'rejected'|'reconciliation_required';
  readonly code:string;
  constructor(kind:'retryable'|'rejected'|'reconciliation_required',code:string) {super(code);this.kind=kind;this.code=code;}
}

/** Runtime opt-in is separate from both Square and Supabase Auth SMTP. No
 * credential is stored in the ledger or returned by the CLI. */
export function composeResendInvoiceEmail(env:NodeJS.ProcessEnv,sendFetch:typeof fetch=fetch):InvoiceEmailTransport|undefined {
  const mode=env.REALBUD_INVOICE_EMAIL_MODE??'off';
  if(mode==='off') return undefined;
  requireThat(mode==='resend','invoice_email_mode_invalid',503);
  const key=env.REALBUD_INVOICE_RESEND_API_KEY;
  const sender=env.REALBUD_INVOICE_FROM;
  requireThat(typeof key==='string' && key.length>=20 && typeof sender==='string' && validBillingEmail(sender),'invoice_email_configuration_incomplete',503);
  return {identity:hash(key),sender,
    async send(bodyJson,idempotencyKey) {
      let response:Response;
      try {
        response=await sendFetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:bodyJson,signal:AbortSignal.timeout(20_000)});
      } catch {throw new InvoiceEmailTransportError('retryable','remote_outcome_unknown');}
      if(response.status===409) {
        // Only the provider's documented machine code is inspected. Never
        // persist or print its response text, which could contain private data.
        let name:unknown;
        try { const error=await response.json();name=error && typeof error==='object' && ('name' in error || 'code' in error)?('name' in error?error.name:error.code):undefined; } catch { /* Unknown conflict needs review. */ }
        if(name==='concurrent_idempotent_requests') throw new InvoiceEmailTransportError('retryable','provider_concurrent_request');
        throw new InvoiceEmailTransportError('reconciliation_required',name==='invalid_idempotent_request'?'provider_payload_conflict':'provider_idempotency_conflict');
      }
      if(response.status===429 || response.status>=500) throw new InvoiceEmailTransportError('retryable','provider_temporarily_unavailable');
      if(response.status===401 || response.status===403) throw new InvoiceEmailTransportError('rejected','provider_auth_rejected');
      if(!response.ok) throw new InvoiceEmailTransportError('rejected','provider_rejected_request');
      let parsed:unknown;
      try {parsed=await response.json();} catch {throw new InvoiceEmailTransportError('retryable','remote_outcome_unknown');}
      const providerId=(parsed && typeof parsed==='object' && 'id' in parsed)?parsed.id:undefined;
      if(typeof providerId!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(providerId)) throw new InvoiceEmailTransportError('retryable','remote_outcome_unknown');
      return {id:providerId};
    }};
}
