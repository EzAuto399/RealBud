/** Additive LOCAL FIXTURE seam. No default transport, publishing, charging or refund-creation API.
 * Square owns any eventual tax invoice. This module owns an immutable usage statement. */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { canonical, id, integer, object, requireThat, type PortalPrincipal } from './contracts.ts';
import { digest, UsageLedger } from './ledger.ts';
import { CARE_FEE_CENTS } from './billing.ts';
import { cents, gstCents, periodAt } from './money.ts';
import { abortable } from './abort.ts';
interface Mapping {companyId:string;merchantId:string;customerId:string;locationId:string;evidence:string}
/** Square runs two entirely separate hosts. A sandbox token sent to the
 * production host fails cryptically, and a production token sent to the sandbox
 * host silently creates drafts nowhere near the real account. The host therefore
 * follows the configured environment and is never inferred from the token's
 * shape. Production is the default, so an existing caller cannot become a
 * sandbox caller by omission; sandbox is always an explicit, visible choice. */
export type SquareEnvironment='production'|'sandbox';
const SQUARE_HOSTS:Record<SquareEnvironment,string>={
  production:'https://connect.squareup.com',
  sandbox:'https://connect.squareupsandbox.com',
};
export interface Statement {
  id:string;companyId:string;period:string;currency:'AUD';gstInclusive:true;kind:'Usage statement';
  lines:{model:string;rateVersion:string;amountNanoAud:string;units:Record<string,number>}[];
  creditNanoAud:string;careAgreementRef:string|null;careCents:number;totalCents:number;gstCents:number;sourceEventIds:number[];deferredRequestIds:string[];
}
interface Outbox {id:string;statement:string;operation:'order'|'invoice';state:'pending'|'running'|'unknown'|'done';body:string}
interface Link {orderId:string;invoiceId?:string;invoiceVersion?:number}
interface MoneyRecord {amount:number;source:string;updatedAt:string}
export class SquareBilling {
  readonly ledger:UsageLedger;
  readonly environment:SquareEnvironment;
  private readonly host:string;
  private readonly transport:typeof fetch|undefined;
  private readonly secret:()=>Promise<string>;
  readonly notificationUrl:string;
  private readonly signatureKey:()=>Promise<string>;
  constructor(options:{ledger:UsageLedger;fetch?:typeof fetch;secret:()=>Promise<string>;notificationUrl:string;signatureKey:()=>Promise<string>;environment?:SquareEnvironment}) {
    this.ledger=options.ledger;this.transport=options.fetch;this.secret=options.secret;this.notificationUrl=options.notificationUrl;this.signatureKey=options.signatureKey;
    const environment=options.environment ?? 'production';
    requireThat(environment==='production'||environment==='sandbox','square_environment_invalid');
    this.environment=environment;this.host=SQUARE_HOSTS[environment];
    requireThat(new URL(this.notificationUrl).protocol==='https:','https_notification_url_required');
  }
  /** Trusted operator seam; no portal route. Mapping changes need an explicit migration. */
  map(mapping:Mapping) {
    Object.values(mapping).forEach(id);this.ledger.tenant(mapping.companyId);
    this.ledger.db.transaction(()=>{const prior=this.ledger.db.get<{body:string}>('SELECT body FROM square_mappings WHERE tenant=?',mapping.companyId);if(prior){requireThat(prior.body===canonical(mapping),'square_mapping_conflict',409);return;}
      this.ledger.db.run('INSERT INTO square_mappings(tenant,merchant,customer,body) VALUES(?,?,?,?)',mapping.companyId,mapping.merchantId,mapping.customerId,canonical(mapping));this.ledger.db.append(mapping.companyId,'square_mapping_recorded',null,this.ledger.now(),mapping);});
  }
  private mapping(companyId:string):Mapping {const row=this.ledger.db.get<{body:string}>('SELECT body FROM square_mappings WHERE tenant=?',companyId);requireThat(row,'square_mapping_required',409);return JSON.parse(row.body);}
  /** Close settled usage; unknown calls stay held and carry into a later statement after reconciliation.
   * Care is explicit per full agreed month. No inferred proration. No customer name/address copy. */
  closeStatement(companyId:string,period:string,careAgreementRef:string|null=null):Statement {
    requireThat(/^\d{4}-(0[1-9]|1[0-2])$/.test(period) && period<periodAt(this.ledger.now()),'month_not_closed',409);if(careAgreementRef)id(careAgreementRef);
    return this.ledger.db.transaction(()=>{
      const existing=this.ledger.db.get<{body:string}>('SELECT body FROM statements WHERE tenant=? AND period=?',companyId,period);
      if(existing){const saved:Statement=JSON.parse(existing.body);requireThat(saved.careAgreementRef===careAgreementRef,'statement_close_conflict',409);return saved;}
      const tenant=this.ledger.tenant(companyId);requireThat(period>=periodAt(tenant.goLiveAt),'period_before_go_live');
      requireThat(!this.ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND period=?',companyId,period),'period_already_invoiced',409);
      requireThat(!this.ledger.db.get('SELECT id FROM statements WHERE tenant=? AND period>?',companyId,period),'statement_period_out_of_order',409);
      const events=this.ledger.db.all<{seq:number;kind:string;body:string}>(`SELECT e.seq,e.kind,e.body FROM events e WHERE e.tenant=? AND e.kind IN ('usage_settled','report_usage_accepted','credit') AND NOT EXISTS(SELECT 1 FROM invoice_events i WHERE i.event=e.seq) AND NOT EXISTS(SELECT 1 FROM statement_events s WHERE s.event=e.seq) AND NOT EXISTS(SELECT 1 FROM refund_intents f WHERE f.credit_event=e.seq) ORDER BY e.seq`,companyId).filter(e=>JSON.parse(e.body).period<=period);
      if(events.some(e=>e.kind==='credit'))requireThat(!this.ledger.db.get('SELECT r.id FROM square_refunds r JOIN square_payments p ON p.id=r.payment JOIN statements s ON s.id=p.statement WHERE s.tenant=?',companyId),'refund_credit_allocation_required',409);
      const groups=new Map<string,Statement['lines'][number]>();let credits=0n;
      for(const e of events){const data=JSON.parse(e.body);if(e.kind==='credit'){credits+=BigInt(data.amountNanoAud);continue;}const key=canonical([data.model,data.rateVersion]);const line:Statement['lines'][number]=groups.get(key)??{model:data.model,rateVersion:data.rateVersion,amountNanoAud:'0',units:{}};line.amountNanoAud=(BigInt(line.amountNanoAud)+BigInt(data.chargedNanoAud)).toString();for(const [unit,count]of Object.entries(data.units)){integer(count);line.units[unit]=(line.units[unit]??0)+count;integer(line.units[unit],Number.MAX_SAFE_INTEGER);}groups.set(key,line);}
      const care=careAgreementRef?CARE_FEE_CENTS:0;const amount=cents([...groups.values()].reduce((n,l)=>n+BigInt(l.amountNanoAud),BigInt(care)*10_000_000n-credits));requireThat(amount>=-BigInt(Number.MAX_SAFE_INTEGER) && amount<=BigInt(Number.MAX_SAFE_INTEGER),'statement_amount_out_of_range');
      const statement:Statement={id:randomUUID(),companyId,period,currency:'AUD',gstInclusive:true,kind:'Usage statement',lines:[...groups.values()],creditNanoAud:credits.toString(),careAgreementRef,careCents:care,totalCents:Number(amount),gstCents:Number(gstCents(amount)),sourceEventIds:events.map(e=>e.seq),deferredRequestIds:this.ledger.requests(companyId).filter(r=>r.period<=period && ['reserved','dispatched','unknown'].includes(r.state)).map(r=>r.id)};
      this.ledger.db.run('INSERT INTO statements(id,tenant,period,body) VALUES(?,?,?,?)',statement.id,companyId,period,canonical(statement));for(const event of events)this.ledger.db.run('INSERT INTO statement_events(event,statement) VALUES(?,?)',event.seq,statement.id);
      this.ledger.db.append(companyId,'statement_closed',null,this.ledger.now(),{statementId:statement.id,digest:digest(statement),deferredCount:statement.deferredRequestIds.length});return statement;
    });
  }
  statement(actor:PortalPrincipal,statementId:string):Statement {const row=this.ledger.db.get<{body:string}>('SELECT body FROM statements WHERE tenant=? AND id=?',actor.companyId,statementId);requireThat(row,'statement_not_found',404);return JSON.parse(row.body);}
  accept(actor:PortalPrincipal,statementId:string,expectedDigest:string) {
    requireThat(actor.role==='billing_owner','forbidden',403);const statement=this.statement(actor,statementId);requireThat(expectedDigest===digest(statement),'statement_changed',409);
    this.ledger.db.transaction(()=>{const prior=this.ledger.db.get('SELECT body FROM statement_acceptances WHERE statement=?',statementId);if(prior)return;const accepted={subject:actor.subject,digest:expectedDigest,acceptedAt:this.ledger.now()};this.ledger.db.run('INSERT INTO statement_acceptances(statement,body) VALUES(?,?)',statementId,canonical(accepted));this.ledger.db.append(actor.companyId,'statement_accepted',null,this.ledger.now(),{statementId,...accepted});});
  }
  private async request(method:'GET'|'POST',path:string,body?:unknown):Promise<Record<string,unknown>> {
    requireThat(this.transport,'external_transport_disabled',503);const signal=AbortSignal.timeout(10000),secret=await abortable(this.secret(),signal);requireThat(secret.length>0,'square_secret_unavailable',503);
    const response=await abortable(this.transport(`${this.host}${path}`,{method,redirect:'error',signal,headers:{Authorization:`Bearer ${secret}`,'Square-Version':'2026-08-19','Content-Type':'application/json'},...(body?{body:canonical(body)}:{})}),signal);
    if(!response.ok){void response.body?.cancel().catch(()=>{});requireThat(false,'square_request_failed',502);}
    requireThat(response.body,'invalid_square_response',502);const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
    try {while(true){const part=await abortable(reader.read(),signal);if(part.done)break;bytes+=part.value.length;requireThat(bytes<=1_000_000,'square_response_too_large',502);chunks.push(part.value);}}finally{void reader.cancel().catch(()=>{});}
    let result:unknown;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{requireThat(false,'invalid_square_response',502);}object(result);requireThat(!result.errors,'square_api_error',502);return result;
  }
  private link(statementId:string):Link|undefined {const row=this.ledger.db.get<{body:string}>('SELECT body FROM square_links WHERE statement=?',statementId);return row?JSON.parse(row.body):undefined;}
  private prepare(statement:Statement,operation:'order'|'invoice',body:unknown):Outbox {
    return this.ledger.db.transaction(()=>{
      const saved=this.ledger.db.get<Outbox>('SELECT * FROM square_outbox WHERE statement=? AND operation=?',statement.id,operation);
      if(saved){const data=JSON.parse(saved.body);requireThat(canonical({...data,idempotency_key:undefined})===canonical(body),'square_outbox_conflict',409);return saved;}
      const key=randomUUID(),payload=canonical({...(body as object),idempotency_key:key});this.ledger.db.run('INSERT INTO square_outbox(id,statement,operation,state,body) VALUES(?,?,?,?,?)',key,statement.id,operation,'pending',payload);return {id:key,statement:statement.id,operation,state:'pending',body:payload};
    });
  }
  private async perform(outbox:Outbox,statement:Statement,mapping:Mapping) {
    this.ledger.db.transaction(()=>{const result=this.ledger.db.run("UPDATE square_outbox SET state='running' WHERE id=? AND state='pending'",outbox.id);requireThat(result.changes===1,'square_reconciliation_required',409);this.ledger.db.append(statement.companyId,'square_dispatch_started',null,this.ledger.now(),{outboxId:outbox.id,operation:outbox.operation});});
    try{const result=await this.request('POST',outbox.operation==='order'?'/v2/orders':'/v2/invoices',JSON.parse(outbox.body));this.finish(outbox,statement,mapping,result);}
    catch{this.ledger.db.run("UPDATE square_outbox SET state='unknown' WHERE id=? AND state='running'",outbox.id);requireThat(false,'square_reconciliation_required',409);}
  }
  private finish(outbox:Outbox,statement:Statement,mapping:Mapping,result:Record<string,unknown>) {
    this.ledger.db.transaction(()=>{
      const link=this.link(statement.id);
      let next:Link;
      if(outbox.operation==='order'){const order=result.order;object(order);id(order.id);requireThat(order.location_id===mapping.locationId && order.customer_id===mapping.customerId && order.reference_id===statement.id,'square_order_scope_mismatch',409);requireThat(money(order.total_money)===statement.totalCents && money(order.total_tax_money)===statement.gstCents,'square_order_amount_mismatch',409);next={orderId:order.id};}
      else {const invoice=result.invoice;object(invoice);object(invoice.primary_recipient);id(invoice.id);integer(invoice.version);requireThat(link && invoice.status==='DRAFT' && invoice.order_id===link.orderId && invoice.location_id===mapping.locationId && invoice.primary_recipient.customer_id===mapping.customerId && invoice.description===`RealBud usage statement ${statement.id}`,'square_invoice_scope_mismatch',409);requireThat(Array.isArray(invoice.payment_requests) && invoice.payment_requests.length===1,'square_invoice_schedule_changed',409);object(invoice.payment_requests[0]);requireThat(money(invoice.payment_requests[0].computed_amount_money)===statement.totalCents,'square_invoice_amount_mismatch',409);next={...link,invoiceId:invoice.id,invoiceVersion:invoice.version};}
      requireThat(!link || link.orderId===next.orderId,'square_order_conflict',409);
      requireThat(!link?.invoiceId || link.invoiceId===next.invoiceId,'square_invoice_conflict',409);
      this.ledger.db.run('INSERT INTO square_links(statement,order_id,invoice_id,body) VALUES(?,?,?,?) ON CONFLICT(statement) DO UPDATE SET invoice_id=excluded.invoice_id,body=excluded.body',statement.id,next.orderId,next.invoiceId??null,canonical(next));
      this.ledger.db.run("UPDATE square_outbox SET state='done' WHERE id=?",outbox.id);this.ledger.db.append(statement.companyId,'square_draft_reconciled',null,this.ledger.now(),{outboxId:outbox.id,...next});
    });
  }
  async createDraft(actor:PortalPrincipal,statementId:string,dueDate:string):Promise<Link> {
    requireThat(this.transport,'external_transport_disabled',503);requireThat(actor.role==='billing_owner','forbidden',403);requireThat(/^\d{4}-\d{2}-\d{2}$/.test(dueDate) && new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0,10)===dueDate,'invalid_due_date');
    const statement=this.statement(actor,statementId),mapping=this.mapping(actor.companyId);
    requireThat(statement.totalCents>0,'nonpositive_statement_requires_adjustment',409);requireThat(this.ledger.db.get('SELECT body FROM statement_acceptances WHERE statement=?',statementId),'statement_not_accepted',409);
    // Bind the authenticated seller and active location before any mocked write.
    const merchant=await this.request('GET',`/v2/merchants/${encodeURIComponent(mapping.merchantId)}`);object(merchant.merchant);requireThat(merchant.merchant.id===mapping.merchantId,'square_merchant_mismatch',403);
    const location=await this.request('GET',`/v2/locations/${encodeURIComponent(mapping.locationId)}`);object(location.location);requireThat(location.location.id===mapping.locationId && location.location.merchant_id===mapping.merchantId && location.location.status==='ACTIVE' && location.location.currency==='AUD','square_location_mismatch',403);
    if(!this.link(statementId)) {
      const outbox=this.prepare(statement,'order',{order:{location_id:mapping.locationId,customer_id:mapping.customerId,reference_id:statement.id,line_items:[{name:`RealBud ${statement.period} — accepted statement`,quantity:'1',base_price_money:{amount:statement.totalCents,currency:'AUD'}}],taxes:[{uid:'gst',name:'GST',percentage:'10',type:'INCLUSIVE',scope:'ORDER'}]}});await this.perform(outbox,statement,mapping);
    }
    const link=this.link(statementId)!;
    const outbox=this.prepare(statement,'invoice',{invoice:{location_id:mapping.locationId,order_id:link.orderId,primary_recipient:{customer_id:mapping.customerId},delivery_method:'SHARE_MANUALLY',description:`RealBud usage statement ${statement.id}`,payment_requests:[{request_type:'BALANCE',due_date:dueDate,automatic_payment_source:'NONE',tipping_enabled:false}],accepted_payment_methods:{card:true,square_gift_card:false,bank_account:false,buy_now_pay_later:false,cash_app_pay:false}}});
    if(outbox.state!=='done')await this.perform(outbox,statement,mapping);return this.link(statementId)!;
  }
  /** Explicit operator recovery after reading a candidate Square ID. No retrying unknown POSTs. */
  async reconcileDraft(actor:PortalPrincipal,statementId:string,operation:'order'|'invoice',remoteId:string) {
    requireThat(actor.role==='billing_owner','forbidden',403);id(remoteId);const statement=this.statement(actor,statementId),mapping=this.mapping(actor.companyId);
    const outbox=this.ledger.db.get<Outbox>('SELECT * FROM square_outbox WHERE statement=? AND operation=?',statementId,operation);requireThat(outbox && ['running','unknown'].includes(outbox.state),'square_recovery_not_needed',409);
    this.finish(outbox,statement,mapping,await this.request('GET',`/v2/${operation==='order'?'orders':'invoices'}/${encodeURIComponent(remoteId)}`));
  }
  /** Signed events trigger authenticated object retrieval; invoice status never becomes money proof. */
  async webhook(raw:Uint8Array,signature:string) {
    requireThat(this.transport,'external_transport_disabled',503);
    requireThat(raw.byteLength<=1_000_000 && /^[A-Za-z0-9+/]{43}=$/.test(signature),'invalid_square_signature',401);
    const key=await this.signatureKey();requireThat(key.length>0,'square_signature_key_unavailable',503);
    const expected=createHmac('sha256',key).update(this.notificationUrl).update(raw).digest();requireThat(timingSafeEqual(expected,Buffer.from(signature,'base64')),'invalid_square_signature',401);
    let event:unknown;try{event=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{requireThat(false,'invalid_square_event');}object(event);id(event.event_id);id(event.merchant_id);object(event.data);id(event.data.id);
    const eventId=event.event_id,eventDigest=digest(event),prior=this.ledger.db.get<{digest:string}>('SELECT digest FROM square_events WHERE id=?',eventId);if(prior){requireThat(prior.digest===eventDigest,'square_event_conflict',409);return;}
    const refund=['refund.created','refund.updated'].includes(String(event.type));requireThat(refund || ['payment.created','payment.updated'].includes(String(event.type)),'unsupported_square_event');
    const response=await this.request('GET',`/v2/${refund?'refunds':'payments'}/${encodeURIComponent(event.data.id)}`),item=refund?response.refund:response.payment;object(item);requireThat(item.id===event.data.id,'square_evidence_id_mismatch',409);
    if(item.status!=='COMPLETED')return; // No money projection; later updates can retry.
    if(refund){id(item.payment_id);const saved=this.ledger.db.get<{statement:string}>('SELECT statement FROM square_payments WHERE id=?',item.payment_id);requireThat(saved,'square_payment_reconciliation_required',409);await this.recordMoney(eventId,eventDigest,event.merchant_id,saved.statement,item,true);}
    else {id(item.order_id);const saved=this.ledger.db.get<{statement:string}>('SELECT statement FROM square_links WHERE order_id=? AND invoice_id IS NOT NULL',item.order_id);requireThat(saved,'square_invoice_reconciliation_required',409);await this.recordMoney(eventId,eventDigest,event.merchant_id,saved.statement,item,false);}
  }
  private async recordMoney(eventId:string,eventDigest:string,merchant:string,statementId:string,item:Record<string,unknown>,refund:boolean) {
    const row=this.ledger.db.get<{tenant:string}>('SELECT tenant FROM statements WHERE id=?',statementId)!;const mapping=this.mapping(row.tenant),link=this.link(statementId)!;
    requireThat(mapping.merchantId===merchant && item.location_id===mapping.locationId,'square_money_scope_mismatch',403);
    if(refund)requireThat(item.unlinked!==true,'unlinked_refund_unsupported',409);
    if(!refund)requireThat(item.order_id===link.orderId && item.customer_id===mapping.customerId && ['CARD','BANK_ACCOUNT','WALLET','CASH','EXTERNAL'].includes(String(item.source_type)),'square_payment_scope_mismatch',403);
    const amount=money(refund?item.amount_money:item.total_money);requireThat(amount>0 && typeof item.updated_at==='string' && Number.isFinite(Date.parse(item.updated_at)),'invalid_square_money');
    const saved:MoneyRecord={amount,source:refund?'refund':String(item.source_type),updatedAt:item.updated_at};
    // Retrieve invoice identity even for manual/CASH/EXTERNAL partial payments. No separate charge.
    const response=await this.request('GET',`/v2/invoices/${encodeURIComponent(link.invoiceId!)}`);object(response.invoice);const invoice=response.invoice;object(invoice.primary_recipient);requireThat(invoice.id===link.invoiceId && invoice.order_id===link.orderId && invoice.location_id===mapping.locationId && invoice.primary_recipient.customer_id===mapping.customerId,'square_invoice_scope_mismatch',409);
    const statement=this.statement({companyId:row.tenant,subject:'square-reconciler',role:'billing_reader'},statementId);
    requireThat(Array.isArray(invoice.payment_requests) && invoice.payment_requests.length===1,'square_invoice_schedule_changed',409);object(invoice.payment_requests[0]);requireThat(money(invoice.payment_requests[0].computed_amount_money)===statement.totalCents,'square_invoice_amount_mismatch',409);
    this.ledger.db.transaction(()=>{
      const duplicate=this.ledger.db.get<{digest:string}>('SELECT digest FROM square_events WHERE id=?',eventId);if(duplicate){requireThat(duplicate.digest===eventDigest,'square_event_conflict',409);return;}
      const table=refund?'square_refunds':'square_payments';const before=this.ledger.db.get<{body:string;statement?:string;payment?:string}>(`SELECT * FROM ${table} WHERE id=?`,String(item.id));
      if(before){requireThat(refund?before.payment===item.payment_id:before.statement===statementId,'square_money_scope_conflict',409);const old:MoneyRecord=JSON.parse(before.body);requireThat(old.amount===saved.amount && old.source===saved.source,'square_money_conflict',409);}
      else {
        if(refund){const p=this.ledger.db.get<{body:string}>('SELECT body FROM square_payments WHERE id=?',String(item.payment_id))!;const total=this.ledger.db.all<{body:string}>('SELECT body FROM square_refunds WHERE payment=?',String(item.payment_id)).reduce((s,r)=>s+(JSON.parse(r.body) as MoneyRecord).amount,0);requireThat(total+amount<=(JSON.parse(p.body) as MoneyRecord).amount,'refund_exceeds_payment',409);this.ledger.db.run('INSERT INTO square_refunds(id,payment,body) VALUES(?,?,?)',String(item.id),String(item.payment_id),canonical(saved));}
        else {const total=this.paymentSummary({companyId:row.tenant,subject:'square-reconciler',role:'billing_reader'},statementId).paidCents;requireThat(total+amount<=statement.totalCents,'square_overpayment_review_required',409);this.ledger.db.run('INSERT INTO square_payments(id,statement,body) VALUES(?,?,?)',String(item.id),statementId,canonical(saved));}
        this.ledger.db.append(row.tenant,refund?'square_refund_verified':'square_payment_verified',null,this.ledger.now(),{statementId,remoteId:item.id,...saved});
      }
      this.ledger.db.run('INSERT INTO square_events(id,digest) VALUES(?,?)',eventId,eventDigest);
    });
  }
  paymentSummary(actor:PortalPrincipal,statementId:string) {
    this.statement(actor,statementId);
    const paidCents=this.ledger.db.all<{body:string}>('SELECT body FROM square_payments WHERE statement=?',statementId).reduce((sum,r)=>sum+(JSON.parse(r.body) as MoneyRecord).amount,0);
    const refundedCents=this.ledger.db.all<{body:string}>('SELECT r.body FROM square_refunds r JOIN square_payments p ON p.id=r.payment WHERE p.statement=?',statementId).reduce((sum,r)=>sum+(JSON.parse(r.body) as MoneyRecord).amount,0);
    return {paidCents,refundedCents,netReceivedCents:paidCents-refundedCents};
  }
}
function money(value:unknown):number {object(value);requireThat(value.currency==='AUD','square_currency_mismatch',409);integer(value.amount,Number.MAX_SAFE_INTEGER);return value.amount;}
