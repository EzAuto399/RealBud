import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BillingService } from './billing.ts';
import { LedgerDatabase } from './database.ts';
import { digest, UsageLedger } from './ledger.ts';
import { careTermsDraft, fixture } from './testing.ts';
import { composeResendInvoiceEmail, deliverInvoiceEmail, drainInvoiceEmails, invoiceEmailStatus, repairRejectedInvoiceEmail, type InvoiceEmailPayload, type InvoiceEmailTransport } from './invoice-email.ts';

const cleanups:(()=>void)[]=[];
afterEach(()=>{while(cleanups.length) cleanups.pop()!();});
function setup(recipient?:string) {
  const f=fixture();cleanups.push(f.close);
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  const draft=careTermsDraft(f,'care-v1','12500');
  if(recipient!==undefined) draft.customer.billingEmail=recipient;
  const published=billing.commercialTerms!.publish(draft);
  billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
  return {f,billing,published};
}
function stub(sender='billing@notify.realbud.app') {
  const requests:{payloadJson:string;key:string}[]=[];
  const transport:InvoiceEmailTransport={identity:'synthetic-resend-account',sender,
    async send(payloadJson,key){requests.push({payloadJson,key});return {id:'synthetic-provider-message-1'};}};
  return {transport,requests};
}

test('an accepted billing email queues one digest-bound office invoice; repeat close never queues or sends another',async()=>{
  const {f,billing,published}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  const original=digest(invoice);
  const outbox=f.db.get<{body:string}>('SELECT body FROM invoice_email_outbox WHERE invoice=?',invoice.id)!;
  const intent=JSON.parse(outbox.body);
  assert.equal(intent.recipient,'accounts@example.test');assert.equal(intent.companyId,'company-a');
  assert.equal(intent.invoiceDigest,original);assert.equal(intent.termsDigest,published.digest);
  assert.equal(invoice.customer.billingEmail,'accounts@example.test');
  assert.equal(invoiceEmailStatus(billing,'company-a',invoice.id).state,'queued');
  assert.throws(()=>invoiceEmailStatus(billing,'company-b',invoice.id),/invoice_not_found/);
  assert.equal(billing.finalizeCommercialInvoice('company-a','2026-09','care-v1').id,invoice.id);
  assert.equal(f.db.all('SELECT invoice FROM invoice_email_outbox').length,1);
  const mail=stub();
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,undefined)).state,'queued');
  assert.equal(mail.requests.length,0);
  const delivered=await deliverInvoiceEmail(billing,'company-a',invoice.id,mail.transport);
  assert.equal(delivered.state,'provider_accepted');assert.equal(delivered.providerMessageId,'synthetic-provider-message-1');
  assert.equal(mail.requests.length,1);
  const sent=JSON.parse(mail.requests[0].payloadJson) as InvoiceEmailPayload;
  assert.equal(sent.to[0],'accounts@example.test');
  assert.match(sent.html,/Invoice RB-000001/);
  assert.match(sent.html,/A\$125\.00/);
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,mail.transport)).state,'provider_accepted');
  assert.equal(mail.requests.length,1);
  assert.equal(digest(JSON.parse(f.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',invoice.id)!.body)),original);
  f.db.verify();
});

test('legacy terms keep their invoice shape and are never silently backfilled',async()=>{
  const {f,billing}=setup();
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  assert.equal(Object.hasOwn(invoice.customer,'billingEmail'),false);
  assert.equal(f.db.all('SELECT invoice FROM invoice_email_outbox').length,0);
  const mail=stub();
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,mail.transport)).state,'not_queued');
  assert.equal(mail.requests.length,0);
});

test('operator close reports one queued email and repeats safely when email mode is off',()=>{
  const dir=mkdtempSync(join(tmpdir(),'realbud-invoice-cli-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const f=fixture(join(dir,'ledger.sqlite'));cleanups.push(f.close);
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  const draft=careTermsDraft(f,'care-v1','12500',{period:'2026-08'});draft.customer.billingEmail='accounts@example.test';
  const published=billing.commercialTerms!.publish(draft);billing.commercialTerms!.accept(f.owner,'2026-08','care-v1',published.digest);
  const run=(...args:string[])=>spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./commercial-cli.ts',import.meta.url)),...args],
    {encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,REALBUD_GATEWAY_DATA:dir,REALBUD_INTERNAL_COMPANY_ID:'realbud-internal',REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES:'company-a',REALBUD_INVOICE_EMAIL_MODE:'off'}});
  const first=run('close','company-a','2026-08','care-v1');assert.equal(first.status,2,first.stderr);
  const firstResult=JSON.parse(first.stdout);assert.equal(firstResult.email.state,'queued');assert.equal(firstResult.state,'closed');
  assert.equal(Object.hasOwn(firstResult.email,'recipient'),false);
  const again=run('close','company-a','2026-08','care-v1');assert.equal(again.status,2,again.stderr);
  const againResult=JSON.parse(again.stdout);assert.equal(againResult.invoiceId,firstResult.invoiceId);
  assert.equal(againResult.email.state,'queued');
  const retry=run('email-deliver','company-a',firstResult.invoiceId);assert.equal(retry.status,2,retry.stderr);
  assert.equal(JSON.parse(retry.stdout).invoiceId,firstResult.invoiceId);
  assert.equal(JSON.parse(retry.stdout).state,'queued');
  assert.equal(f.db.all('SELECT invoice FROM invoice_email_outbox').length,1);
});

test('publication rejects a changed, ambiguous or unsafe recipient address',()=>{
  const f=fixture();cleanups.push(f.close);
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  for(const email of [' accounts@example.test','accounts@example.test\nBcc:other@example.test','a@@example.test','a@localhost','a..b@example.test','a@example.test ']) {
    const draft=careTermsDraft(f,'care-v1','12500');draft.customer.billingEmail=email;
    assert.throws(()=>billing.commercialTerms!.publish(draft),/commercial_billing_email_invalid/,email);
  }
  assert.equal(f.db.all('SELECT seq FROM commercial_terms').length,0);
});

test('ambiguous timeout retries with the identical frozen sender, payload and key, then records provider acceptance',async()=>{
  const {f,billing}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  const calls:{payload:string;key:string}[]=[];
  const transport:InvoiceEmailTransport={identity:'synthetic-resend-account',sender:'billing@notify.realbud.app',async send(payloadJson,key){
    calls.push({payload:payloadJson,key});
    if(calls.length===1) throw Error('synthetic timeout after remote acceptance');
    return {id:'provider-same-logical-email'};
  }};
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,transport)).state,'retryable');
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,transport)).state,'retryable');
  assert.equal(calls.length,1);
  f.setTime(f.now()+60_000);
  // A config edit cannot change the message while its first provider outcome is uncertain.
  const changed={...transport,sender:'new-sender@notify.realbud.app'};
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,changed)).state,'provider_accepted');
  assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
  assert.equal(invoiceEmailStatus(billing,'company-a',invoice.id).attempts,2);
  f.db.verify();
});

test('a stale uncertain attempt stops before provider idempotency expires',async()=>{
  const {f,billing}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  let calls=0;
  const transport:InvoiceEmailTransport={identity:'synthetic-resend-account',sender:'billing@notify.realbud.app',async send(){calls++;throw Error('synthetic timeout');}};
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,transport)).state,'retryable');
  f.setTime(f.now()+20*60*60_000);
  const status=await deliverInvoiceEmail(billing,'company-a',invoice.id,transport);
  assert.equal(status.state,'reconciliation_required');assert.equal(calls,1);
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,transport)).state,'reconciliation_required');
  assert.equal(calls,1);
});

test('a live lease prevents concurrent dispatch',async()=>{
  const {f,billing}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  let release:(value:{id:string})=>void=()=>{};
  let entered:()=>void=()=>{};
  const firstEntered=new Promise<void>(resolve=>{entered=resolve;});
  const response=new Promise<{id:string}>(resolve=>{release=resolve;});
  let calls=0;
  const transport:InvoiceEmailTransport={identity:'synthetic-resend-account',sender:'billing@notify.realbud.app',async send(){calls++;entered();return response;}};
  const first=deliverInvoiceEmail(billing,'company-a',invoice.id,transport);
  await firstEntered;
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,transport)).state,'sending');
  assert.equal(calls,1);
  release({id:'provider-one'});
  assert.equal((await first).state,'provider_accepted');
  assert.equal(calls,1);
  f.db.verify();
});

test('a second SQLite connection observes the first process lease without dispatching',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'realbud-invoice-email-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const f=fixture(join(dir,'gateway.sqlite'));cleanups.push(f.close);f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  const draft=careTermsDraft(f,'care-v1','12500');draft.customer.billingEmail='accounts@example.test';
  const published=billing.commercialTerms!.publish(draft);billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  const secondDb=new LedgerDatabase(join(dir,'gateway.sqlite'));cleanups.push(()=>secondDb.close());
  const secondBilling=new BillingService(new UsageLedger(secondDb,f.now),undefined,{internalCompanyId:'realbud-internal'});
  let release:(value:{id:string})=>void=()=>{};
  let entered:()=>void=()=>{};
  const firstEntered=new Promise<void>(resolve=>{entered=resolve;});
  const response=new Promise<{id:string}>(resolve=>{release=resolve;});
  let calls=0;
  const transport:InvoiceEmailTransport={identity:'synthetic-resend-account',sender:'billing@notify.realbud.app',async send(){calls++;entered();return response;}};
  const first=deliverInvoiceEmail(billing,'company-a',invoice.id,transport);
  await firstEntered;
  assert.equal((await deliverInvoiceEmail(secondBilling,'company-a',invoice.id,transport)).state,'sending');
  assert.equal(calls,1);
  release({id:'provider-one'});
  assert.equal((await first).state,'provider_accepted');
  assert.equal(invoiceEmailStatus(secondBilling,'company-a',invoice.id).state,'provider_accepted');
});

test('after a crash-length lease, retry uses the exact bytes and a late failure cannot downgrade acceptance',async()=>{
  const {f,billing}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  let rejectFirst:(error:Error)=>void=()=>{};
  let entered:()=>void=()=>{};
  const firstEntered=new Promise<void>(resolve=>{entered=resolve;});
  const firstResponse=new Promise<{id:string}>((_,reject)=>{rejectFirst=reject;});
  const calls:{body:string;key:string}[]=[];
  const transport:InvoiceEmailTransport={identity:'synthetic-resend-account',sender:'billing@notify.realbud.app',async send(body,key){
    calls.push({body,key});if(calls.length===1) {entered();return firstResponse;}
    return {id:'provider-one'};
  }};
  const first=deliverInvoiceEmail(billing,'company-a',invoice.id,transport);
  await firstEntered;
  f.setTime(f.now()+61_000);
  assert.equal((await drainInvoiceEmails(billing,transport)).accepted,1);
  assert.deepEqual(calls[0],calls[1]);
  rejectFirst(Error('late synthetic timeout'));
  assert.equal((await first).state,'provider_accepted');
  assert.equal(invoiceEmailStatus(billing,'company-a',invoice.id).attempts,2);
  f.db.verify();
});

test('an AI invoice email contains the full invoice and an absolute account link',async()=>{
  const f=fixture();cleanups.push(f.close);f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  const draft=careTermsDraft(f,'care-v1','12500');draft.customer.billingEmail='accounts@example.test';
  draft.aiUsage={billing:'resale',markupBasisPoints:3000,termsReference:'synthetic-resale-terms'};
  const published=billing.commercialTerms!.publish(draft);billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1',{invoices:[{id:'CI-000001',period:'2026-09',totalCents:'1200',gstCents:'109'}]});
  const mail=stub();await deliverInvoiceEmail(billing,'company-a',invoice.id,mail.transport);
  const html=(JSON.parse(mail.requests[0].payloadJson) as InvoiceEmailPayload).html;
  assert.match(html,/Modelvia invoice CI-000001/);
  assert.match(html,/https:\/\/realbud\.app\/api\/account\/invoices\/RB-000001\/ai-usage/);
  assert.doesNotMatch(html,/href="\/api\/account/);
});

test('Resend composition is off by default and uses the exact idempotency header without a live call',async()=>{
  assert.equal(composeResendInvoiceEmail({}),undefined);
  let captured:{url:string;init:RequestInit}|undefined;
  const fakeFetch:typeof fetch=async(input,init)=>{
    captured={url:String(input),init:init!};return new Response(JSON.stringify({id:'provider-123'}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const sender=composeResendInvoiceEmail({REALBUD_INVOICE_EMAIL_MODE:'resend',REALBUD_INVOICE_RESEND_API_KEY:'synthetic-resend-key-123456',REALBUD_INVOICE_FROM:'billing@notify.realbud.app'},fakeFetch)!;
  assert.deepEqual(await sender.send(JSON.stringify({from:sender.sender,to:['accounts@example.test'],subject:'Synthetic',html:'<p>invoice</p>'}),'stable-key'),{id:'provider-123'});
  assert.equal(captured?.url,'https://api.resend.com/emails');
  assert.equal((captured?.init.headers as Record<string,string>)['Idempotency-Key'],'stable-key');
  assert.equal(JSON.parse(String(captured?.init.body)).to[0],'accounts@example.test');
});

test('Resend concurrent-key conflict is retryable but changed-payload conflict requires reconciliation',async()=>{
  for(const [name,expected] of [['concurrent_idempotent_requests','retryable'],['invalid_idempotent_request','reconciliation_required']] as const) {
    const f=fixture();cleanups.push(f.close);f.setTime(Date.parse('2026-10-01T00:00:00Z'));
    const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
    const draft=careTermsDraft(f,'care-v1','12500');draft.customer.billingEmail='accounts@example.test';
    const published=billing.commercialTerms!.publish(draft);billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
    const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
    const fakeFetch:typeof fetch=async()=>new Response(JSON.stringify({name,message:'synthetic private response'}),{status:409});
    const sender=composeResendInvoiceEmail({REALBUD_INVOICE_EMAIL_MODE:'resend',REALBUD_INVOICE_RESEND_API_KEY:'synthetic-resend-key-123456',REALBUD_INVOICE_FROM:'billing@notify.realbud.app'},fakeFetch)!;
    const status=await deliverInvoiceEmail(billing,'company-a',invoice.id,sender);
    assert.equal(status.state,expected);assert.doesNotMatch(JSON.stringify(status),/synthetic private response/);
  }
});

test('drain retries an uncertain result, reports nonacceptance, and stops scanning after acceptance',async()=>{
  const {f,billing}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  let calls=0;
  const transport:InvoiceEmailTransport={identity:'synthetic-resend-account',sender:'billing@notify.realbud.app',async send(){
    calls++;if(calls===1) throw Error('synthetic timeout');return {id:'provider-one'};
  }};
  const first=await drainInvoiceEmails(billing,transport);
  assert.deepEqual(first,{scanned:1,accepted:0,nonaccepted:1,reconciliationRequired:0,rejected:0,retryable:1,errors:0});
  assert.equal((await drainInvoiceEmails(billing,transport)).scanned,0);
  f.setTime(f.now()+60_000);
  const retry=await drainInvoiceEmails(billing,transport);
  assert.equal(retry.accepted,1);assert.equal(calls,2);
  assert.equal((await drainInvoiceEmails(billing,transport)).scanned,0);
  assert.equal(invoiceEmailStatus(billing,'company-a',invoice.id).state,'provider_accepted');
});

test('drain skips older never-attempted invoices until explicit operator delivery',async()=>{
  const {f,billing}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  const mail=stub();f.setTime(f.now()+60*60_000+1);
  assert.equal((await drainInvoiceEmails(billing,mail.transport)).scanned,0);
  assert.equal(invoiceEmailStatus(billing,'company-a',invoice.id).manualReviewRequired,true);
  assert.equal(mail.requests.length,0);
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,mail.transport)).state,'provider_accepted');
});

test('rotated key on an ambiguous attempt moves it to reconciliation instead of starving the drain',async()=>{
  const {f,billing}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  let calls=0;
  const first:InvoiceEmailTransport={identity:'original-account-key',sender:'billing@notify.realbud.app',async send(){calls++;throw Error('synthetic timeout');}};
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,first)).state,'retryable');
  f.setTime(f.now()+60_000);
  const rotated:InvoiceEmailTransport={identity:'rotated-account-key',sender:'billing@notify.realbud.app',async send(){calls++;return {id:'unexpected'};}};
  const result=await drainInvoiceEmails(billing,rotated);
  assert.equal(result.reconciliationRequired,1);assert.equal(result.nonaccepted,1);
  assert.equal(calls,1);
  assert.equal((await drainInvoiceEmails(billing,rotated)).scanned,0);
  assert.equal(invoiceEmailStatus(billing,'company-a',invoice.id).failureCode,'transport_identity_changed');
});

test('a first definite 401 or 403 can be audited and repaired with a new key, then manually delivered',async()=>{
  for(const code of [401,403]) {
    const {f,billing}=setup('accounts@example.test');
    const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
    const oldKey='synthetic-resend-key-123456';const newKey='corrected-resend-key-123456';
    let oldIdempotency='';let newIdempotency='';
    const rejected=composeResendInvoiceEmail({REALBUD_INVOICE_EMAIL_MODE:'resend',REALBUD_INVOICE_RESEND_API_KEY:oldKey,REALBUD_INVOICE_FROM:'billing@notify.realbud.app'},
      async(_input,init)=>{oldIdempotency=(init?.headers as Record<string,string>)['Idempotency-Key'];return new Response(null,{status:code});})!;
    assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,rejected)).failureCode,'provider_auth_rejected');
    const corrected=composeResendInvoiceEmail({REALBUD_INVOICE_EMAIL_MODE:'resend',REALBUD_INVOICE_RESEND_API_KEY:newKey,REALBUD_INVOICE_FROM:'billing@notify.realbud.app'},
      async(_input,init)=>{newIdempotency=(init?.headers as Record<string,string>)['Idempotency-Key'];return new Response(JSON.stringify({id:'provider-after-repair'}),{status:200});})!;
    const repaired=repairRejectedInvoiceEmail(billing,'company-a',invoice.id,corrected,'operator-cli:tester','reviewed-auth-correction');
    assert.equal(repaired.state,'queued');assert.equal(repaired.manualReviewRequired,true);
    assert.equal((await drainInvoiceEmails(billing,corrected)).scanned,0);
    assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,corrected)).state,'provider_accepted');
    assert.notEqual(oldIdempotency,newIdempotency);
    assert.equal(f.db.all("SELECT seq FROM events WHERE kind='invoice_email_auth_repaired'").length,1);
    f.db.verify();
  }
});

test('auth repair refuses an attempt with earlier remote ambiguity',async()=>{
  const {f,billing}=setup('accounts@example.test');
  const invoice=billing.finalizeCommercialInvoice('company-a','2026-09','care-v1');
  let calls=0;
  const original=composeResendInvoiceEmail({REALBUD_INVOICE_EMAIL_MODE:'resend',REALBUD_INVOICE_RESEND_API_KEY:'synthetic-resend-key-123456',REALBUD_INVOICE_FROM:'billing@notify.realbud.app'},
    async()=>{calls++;return new Response(null,{status:calls===1?500:401});})!;
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,original)).state,'retryable');
  f.setTime(f.now()+60_000);
  assert.equal((await deliverInvoiceEmail(billing,'company-a',invoice.id,original)).state,'rejected');
  const corrected=stub().transport;
  assert.throws(()=>repairRejectedInvoiceEmail(billing,'company-a',invoice.id,corrected,'operator-cli:tester','reviewed-auth-correction'),/invoice_email_repair_requires_definite_first_auth_rejection/);
  assert.equal((await drainInvoiceEmails(billing,corrected)).scanned,0);
});
