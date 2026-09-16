/** Offline, synthetic integration rehearsal. No provider or payment network calls. */
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { fixture } from './testing.ts';
import { invoiceHtml } from './invoice-html.ts';
const target=resolve(process.argv[2]??'managed-gateway/evidence/demo');
const f=fixture();
try {
  const stream=await f.run();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const invoice=f.billing.finalizeLocalInvoice('company-a','2026-09','synthetic-care-agreement');
  const checkout=await f.billing.checkout(f.owner,invoice.id);
  const saved=JSON.parse(f.db.get<{body:string}>('SELECT body FROM checkouts WHERE invoice=?',invoice.id)!.body);
  const signed=f.signedEvent({mode:'local',status:'settled',payment:{eventId:'synthetic-event',transactionId:'synthetic-transaction',invoiceId:invoice.id,attemptId:saved.attemptId,sessionId:checkout.sessionId,amountCents:invoice.totalCents,currency:'AUD',settledAt:f.now()}});
  await f.billing.webhook(signed.raw,signed.signature);const duplicate=await f.billing.webhook(signed.raw,signed.signature);f.db.verify();
  mkdirSync(target,{recursive:true});writeFileSync(join(target,'invoice.html'),invoiceHtml(invoice));writeFileSync(join(target,'invoice.json'),JSON.stringify(invoice,null,2));
  const result={mode:'synthetic-local-only',realProviderCalls:0,realPayments:0,stream,invoiceId:invoice.id,receipt:f.billing.receipt(f.owner,invoice.id),duplicateWebhook:duplicate,ledgerIntegrity:'passed',portal:f.ledger.portalUsage(f.owner)};
  writeFileSync(join(target,'result.json'),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify({output:target,mode:result.mode,realProviderCalls:0,realPayments:0,invoice:invoice.id})+'\n');
}finally{f.close();}
