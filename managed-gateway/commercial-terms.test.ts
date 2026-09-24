import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingService } from './billing.ts';
import { LedgerDatabase } from './database.ts';
import { invoiceHtml } from './invoice-html.ts';
import { createGatewayServer } from './http.ts';
import { digest } from './ledger.ts';
import { careTermsDraft, fixture } from './testing.ts';
import type { PortalPrincipal } from './contracts.ts';

const draft=careTermsDraft;

test('latest month-specific owner acceptance and exact per-customer care amount bind an immutable collected invoice',async()=>{
  const f=fixture();try {
    await f.run();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
    const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'}),terms=billing.commercialTerms!;
    assert.throws(()=>terms.publish({...draft(f,'bad-extra','9900'),privateSupplierCost:'must-never-reach-portal'} as never),/invalid_fields/);
    const v1=terms.publish(draft(f,'month-v1','9900'));
    assert.throws(()=>billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','month-v1'),/commercial_terms_not_accepted/);
    terms.accept(f.owner,'2026-09','month-v1',v1.digest);
    const v2=terms.publish(draft(f,'month-v2','7500'));
    assert.throws(()=>terms.accept(f.owner,'2026-09','month-v1',v1.digest),/commercial_terms_changed/);
    assert.throws(()=>billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','month-v1'),/commercial_terms_stale/);
    assert.throws(()=>terms.accept(f.owner,'2026-09','month-v2',v1.digest),/commercial_terms_changed/);
    assert.throws(()=>terms.accept({...f.owner,role:'billing_reader'},'2026-09','month-v2',v2.digest),/forbidden/);
    terms.accept(f.owner,'2026-09','month-v2',v2.digest);
    const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','month-v2');
    assert.equal(invoice.mode,'commercial');assert.equal(invoice.careAgreementRef,'synthetic-care-agreement');
    assert.equal(invoice.lines.find(line=>line.description.includes('monthly care'))?.amountCents,'7500');
    assert.equal(invoice.lines.length,1);
    assert.equal(invoice.commercialTerms?.digest,v2.digest);
    const binding=terms.assertCollectible(invoice,terms.sellerBasisDigest(v2.terms));
    assert.equal(binding.amountCents,invoice.totalCents);assert.equal(binding.invoiceDigest,digest(invoice));
    assert.throws(()=>terms.assertCollectible(invoice,'0'.repeat(64)),/seller_basis_not_approved/);
    assert.equal(billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','month-v2').id,invoice.id);
    assert.throws(()=>terms.publish(draft(f,'month-v3','6000')),/commercial_period_already_closed/);
    const html=invoiceHtml(invoice);assert.match(html,/Fictional RealBud Seller/);assert.match(html,/1 Example Seller Street/);
    assert.doesNotMatch(html,/LOCAL TEST DOCUMENT/);
    f.db.verify();
  }finally{f.close();}
});

test('a zero care amount closes as a nothing-to-pay invoice that is not collectible',()=>{
  const f=fixture();try {
    f.setTime(Date.parse('2026-10-01T00:00:00Z'));
    const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'}),terms=billing.commercialTerms!;
    assert.throws(()=>terms.publish(draft(f,'zero-bad','0',{careAgreementRef:'synthetic-care-agreement'})),/care_terms_invalid/);
    const zero=terms.publish(draft(f,'zero','0'));terms.accept(f.owner,'2026-09','zero',zero.digest);
    const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','zero');
    assert.equal(invoice.totalCents,'0');assert.equal(invoice.lines.length,0);assert.equal(invoice.careAgreementRef,null);
    assert.throws(()=>terms.assertCollectible(invoice),/commercial_invoice_not_collectible/);
  }finally{f.close();}
});

test('authenticated portal exposes only tenant terms and records the billing owner acceptance',async()=>{
  const f=fixture();f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  const published=billing.commercialTerms!.publish(draft(f,'portal-v1','5000'));
  let principal:PortalPrincipal={...f.owner};
  const server=createGatewayServer({billing,allowedOrigins:new Set(),portal:{async authenticate(){return principal;}}});
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,authorization='Bearer fixture-owner-token-123456789';
    const get=await fetch(`${base}/v1/portal/commercial-terms?period=2026-09`,{headers:{authorization}});
    assert.equal(get.status,200);assert.equal((await get.json()).digest,published.digest);
    const accept=()=>fetch(`${base}/v1/portal/commercial-terms/accept`,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({period:'2026-09',version:'portal-v1',digest:published.digest})});
    principal={...f.owner,role:'billing_reader'};assert.equal((await accept()).status,403);
    // Another tenant sees no terms at all, so it cannot accept these.
    principal={...f.owner,companyId:'company-b'};assert.equal((await accept()).status,404);
    principal={...f.owner};assert.equal((await accept()).status,200);
    assert.equal(billing.commercialTerms!.current(f.owner,'2026-09').acceptance?.digest,published.digest);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

test('internal cost tenant cannot publish terms or close an invoice',()=>{
  const f=fixture();try {
    f.setTime(Date.parse('2026-10-01T00:00:00Z'));
    f.ledger.provisionTenant({...f.tenant,companyId:'internal-flagged',licenseId:'internal-license',billingMode:'internal_cost'});
    assert.throws(()=>f.ledger.provisionTenant({...f.tenant,companyId:'bad-mode',licenseId:'bad-license',billingMode:'partner' as never}),/invalid_billing_mode/);
    const billing=new BillingService(f.ledger,undefined,{internalCompanyId:f.tenant.companyId});
    assert.throws(()=>billing.commercialTerms!.publish(draft(f,'v1','9900')),/internal_usage_not_billable/);
    assert.throws(()=>billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','v1'),/internal_usage_not_billable/);
    const other=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
    assert.throws(()=>other.commercialTerms!.publish(draft({tenant:{...f.tenant,companyId:'internal-flagged'}},'v1','9900')),/internal_usage_not_billable/);
    assert.throws(()=>other.finalizeCommercialInvoice('internal-flagged','2026-09','v1'),/internal_usage_not_billable/);
    assert.equal(f.db.all('SELECT id FROM invoices').length,0);assert.equal(f.db.all('SELECT * FROM commercial_terms').length,0);
  }finally{f.close();}
});

test('v2 ledger upgrade adds commercial records without rewriting an existing invoice',()=>{
  const directory=mkdtempSync(join(tmpdir(),'realbud-commercial-migration-'));
  const path=join(directory,'ledger.sqlite');
  try {
    const f=fixture(path);f.setTime(Date.parse('2026-10-01T00:00:00Z'));
    const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
    const published=billing.commercialTerms!.publish(draft(f,'v1','9900'));billing.commercialTerms!.accept(f.owner,'2026-09','v1',published.digest);
    const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','v1');
    const original=f.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',invoice.id)!.body;
    // A v2 ledger: the invoice exists, the commercial tables do not yet.
    f.db.sql.exec('DROP TABLE collection_invoice_bindings; DROP TABLE commercial_acceptances; DROP TABLE commercial_terms; PRAGMA user_version=2;');
    f.close();
    const migrated=new LedgerDatabase(path);
    try {
      assert.equal(migrated.get<{body:string}>('SELECT body FROM invoices WHERE id=?',invoice.id)?.body,original);
      assert.equal(migrated.get<{user_version:number}>('PRAGMA user_version')?.user_version,3);
      assert.equal(migrated.all('SELECT * FROM commercial_terms').length,0);
      migrated.verify();
    }finally{migrated.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});
