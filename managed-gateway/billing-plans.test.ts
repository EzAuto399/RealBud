/** Billing plans: accept once, roll forward. Every identity, amount and key is
 * fictional; Modelvia is a stub shaped like the client billing routes. */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { careTermsDraft, fixture } from './testing.ts';
import { BillingService, INCLUDED_SERVICE_LINE, absorbedAiPeriods, type Invoice } from './billing.ts';
import { addMonths, BillingPlans, composeBillingPlanConfig, nextPeriod, presentCommercialTerms, type BillingPlanConfig } from './billing-plans.ts';
import { digest } from './ledger.ts';
import { isStandingAcceptance, latestResaleAcceptance, resaleAcceptanceReference, type CommercialAcceptance } from './commercial-terms.ts';
import { closeList, closeMonth, operatorInvoice } from './operator-billing.ts';
import type { ModelviaClientBilling, ModelviaCustomerInvoice } from './modelvia-client-billing.ts';
import { OPERATOR_ROLE } from './operator-token.ts';
import { bindOfficeCustomer } from './provisioning.ts';

const cleanups:(()=>void)[]=[];afterEach(()=>{while(cleanups.length)cleanups.pop()!();});
const INTERNAL='realbud-internal', CUSTOMER='realbud-company-a', SELLER_ABN='12345678901';
const OPERATOR={subject:'operator:ops@realbud.example',role:OPERATOR_ROLE} as const;
const RESALE={clientMarkupBasisPoints:3000,termsReference:'realbud-office-terms-2026-09-26-ai-resale-30pct'};
const ENV={REALBUD_SELLER_LEGAL_NAME:'Fictional RealBud Seller',REALBUD_SELLER_ABN:SELLER_ABN,REALBUD_SELLER_ADDRESS:'1 Example Seller Street, Brisbane QLD',REALBUD_TAX_TREATMENT_REF:'synthetic-tax-review',
  REALBUD_SELLER_VERIFICATION_REF:'synthetic-seller-review',REALBUD_CUSTOMER_TERMS_REF:'synthetic-customer-contract',REALBUD_CARE_AGREEMENT_REF:'synthetic-care-agreement'};
const AUSTIN={startPeriod:'2026-09',includedMonths:2,careCents:'12500',aiBilling:'resale'} as const;
const at=(iso:string)=>Date.parse(iso);

/** Modelvia's finalized customer invoices for the office, read only. */
function modelviaStub(finalized:{id:string;period:string;totalCents:string;gstCents:string}[]) {
  const calls:string[]=[];
  const invoice=(entry:typeof finalized[number]):ModelviaCustomerInvoice=>({...entry,kind:'Tax Invoice',clientId:'realbud',customerId:CUSTOMER,seller:{legalName:'Fictional RealBud Seller',abn:SELLER_ABN},
    lines:[{description:'AI usage — Synthetic model — 1 request',amountCents:entry.totalCents,gstCents:entry.gstCents,model:'synthetic',requestCount:1}],chargeDetail:'all_in',paid:false,paymentState:'not_started',checkoutAvailable:false,directPaymentAvailable:false});
  const client:ModelviaClientBilling={
    async customerMonth(_customer,period){ calls.push(`month:${period}`); return {invoices:finalized.filter(i=>i.period<=period).map(({id,period,totalCents,gstCents})=>({id,period,totalCents,gstCents})),customerCheckout:'off',usageExpected:finalized.some(i=>i.period===period)}; },
    async customerInvoice(_customer,id){ calls.push(`invoice:${id}`); return invoice(finalized.find(i=>i.id===id)!); },
    async customerMargins(){ return new Map(); },
  };
  return {client,calls};
}
function office(options:{config?:BillingPlanConfig|{unavailable:string};clientFunded?:string[];resale?:boolean}={}) {
  const f=fixture();cleanups.push(f.close);
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:INTERNAL});
  const config=options.config??composeBillingPlanConfig(ENV);
  const clientFundedCompanies=new Set(options.clientFunded??[]);
  const plans=new BillingPlans({billing,config,clientFundedCompanies,...(options.resale===false?{}:{resale:RESALE})});
  bindOfficeCustomer(f.ledger,f.tenant.companyId,CUSTOMER);
  const modelvia=modelviaStub([{id:'CI-000009',period:'2026-09',totalCents:'4400',gstCents:'400'},{id:'CI-000010',period:'2026-10',totalCents:'6600',gstCents:'600'},{id:'CI-000011',period:'2026-11',totalCents:'8800',gstCents:'800'}]);
  const close=(period:string,deferAi?:boolean)=>closeMonth({billing,modelvia:modelvia.client,clientFundedCompanies,plans},OPERATOR,{companyId:f.tenant.companyId,period,...(deferAi===undefined?{}:{deferAi})});
  const list=(period:string)=>closeList(billing,period,plans).offices.find(o=>o.companyId===f.tenant.companyId)!;
  const accept=(period:string)=>{ const current=billing.commercialTerms!.current(f.owner,period); return billing.commercialTerms!.accept(f.owner,period,current.terms.version,current.digest); };
  return {f,billing,plans,modelvia,close,list,accept,terms:billing.commercialTerms!};
}

test('config: every seller and reference variable, checked by name; a reviewed seller-basis digest must match',()=>{
  const config=composeBillingPlanConfig(ENV);
  assert.ok(!('unavailable' in config));
  assert.deepEqual(config.seller,{legalName:'Fictional RealBud Seller',product:'RealBud',abn:SELLER_ABN,address:'1 Example Seller Street, Brisbane QLD',gstRegistered:true});
  for(const name of Object.keys(ENV)) assert.deepEqual(composeBillingPlanConfig({...ENV,[name]:''}),{unavailable:`billing_plan_unconfigured:${name}`},name);
  assert.deepEqual(composeBillingPlanConfig({...ENV,REALBUD_SELLER_ABN:'8499252636'}),{unavailable:'billing_plan_unconfigured:REALBUD_SELLER_ABN'});
  assert.deepEqual(composeBillingPlanConfig({...ENV,REALBUD_CARE_AGREEMENT_REF:'has spaces'}),{unavailable:'billing_plan_unconfigured:REALBUD_CARE_AGREEMENT_REF'});
  assert.deepEqual(composeBillingPlanConfig({...ENV,REALBUD_SELLER_BASIS_DIGEST:'a'.repeat(64)}),{unavailable:'billing_plan_unconfigured:REALBUD_SELLER_BASIS_DIGEST'});
  const reviewed=digest({seller:config.seller,tax:config.tax,sellerVerificationRef:config.sellerVerificationRef});
  assert.ok(!('unavailable' in composeBillingPlanConfig({...ENV,REALBUD_SELLER_BASIS_DIGEST:reviewed})));
  assert.deepEqual([addMonths('2026-11',2),addMonths('2026-12',1),addMonths('2026-03',-3),nextPeriod(at('2026-09-30T20:00:00Z'))],['2027-01','2027-01','2025-12','2026-11']);
});

test('Austin: plan set in September, accepted once; September and October close as A$0 included months with Modelvia never read; November bills A$125 care plus its own AI only',async()=>{
  const {f,billing,plans,modelvia,close,list,accept,terms}=office();
  // 15 September: the plan publishes September and October (next month).
  const set=plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN});
  assert.deepEqual([set.plan!.version,set.plan!.markupBasisPoints,set.plan!.termsReference,set.plan!.setBy,set.acceptance,set.rollForward],['plan-v1',3000,RESALE.termsReference,OPERATOR.subject,{state:'awaiting_owner',acceptedAt:null},{published:['2026-09','2026-10'],blocker:null}]);
  assert.deepEqual(set.months.map(m=>[m.period,m.version,m.careCents,m.aiBilled,m.included,m.state]),[['2026-09','plan-v1','0',false,true,'published'],['2026-10','plan-v1','0',false,true,'published']]);
  const september=terms.current(f.owner,'2026-09');
  assert.deepEqual([september.terms.version,september.terms.careCents,september.terms.careAgreementRef,september.terms.aiUsage,september.terms.customer],['plan-v1-2026-09','0',null,undefined,{name:f.tenant.customerName,address:f.tenant.customerAddress}]);
  assert.deepEqual(september.terms.billingPlan,{version:'plan-v1',startPeriod:'2026-09',includedMonths:2,careCents:'12500',aiBilling:'resale',markupBasisPoints:3000,termsReference:RESALE.termsReference});
  assert.deepEqual(september.terms.seller,{legalName:'Fictional RealBud Seller',product:'RealBud',abn:SELLER_ABN,address:'1 Example Seller Street, Brisbane QLD',gstRegistered:true});
  assert.equal(list('2026-09').blocker,'plan_awaiting_owner');
  await assert.rejects(close('2026-09'),/plan_awaiting_owner/);
  // The owner accepts September: the plan is accepted, October is covered by a
  // standing acceptance, and AI resale is accepted from the first month.
  f.setTime(at('2026-09-20T00:00:00Z'));
  const anchor=accept('2026-09');
  assert.equal(anchor.subject,f.owner.subject);
  const october=terms.current(f.owner,'2026-10');
  assert.ok(october.acceptance && isStandingAcceptance(october.acceptance));
  assert.equal(october.acceptance!.subject,`standing:${digest(anchor)}`);
  assert.deepEqual(plans.view(f.tenant.companyId).acceptance,{state:'accepted',acceptedAt:anchor.acceptedAt});
  assert.deepEqual(plans.view(f.tenant.companyId).months.map(m=>m.state),['accepted','standing']);
  const resale=latestResaleAcceptance(f.ledger,f.tenant.companyId)!;
  assert.deepEqual(resale,{period:'2026-09',version:'plan-v1-2026-09',markupBasisPoints:3000,termsReference:RESALE.termsReference,acceptanceReference:resaleAcceptanceReference(RESALE.termsReference,anchor)});
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind='ai_resale_terms_accepted'").length,1);
  // 5 October: September closes as an A$0 Tax Invoice with the one included line.
  f.setTime(at('2026-10-05T00:00:00Z'));
  assert.deepEqual(list('2026-09'),{companyId:f.tenant.companyId,officeName:f.tenant.customerName,invoiceId:null,termsVersion:'plan-v1-2026-09',state:'ready',blocker:null});
  const sept=await close('2026-09');
  assert.deepEqual([sept.ai,sept.alreadyClosed,sept.invoice.kind,sept.invoice.totalCents,sept.invoice.gstCents,sept.invoice.status,sept.invoice.outstandingCents],['included',false,'Tax Invoice','0','0','nothing_due','0']);
  const septInvoice=JSON.parse(f.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',sept.invoice.id)!.body) as Invoice;
  assert.deepEqual(septInvoice.lines,[{description:INCLUDED_SERVICE_LINE,amountNanoAud:'0',amountCents:'0',gstCents:'0'}]);
  assert.deepEqual([...absorbedAiPeriods(f.ledger,f.tenant.companyId)],['2026-09']);
  assert.deepEqual(modelvia.calls,[]);
  // 3 November: the roll-forward publishes November (care + AI) and December, both standing.
  f.setTime(at('2026-11-03T00:00:00Z'));
  assert.equal(list('2026-10').state,'ready');
  const november=terms.current(f.owner,'2026-11'), december=terms.current(f.owner,'2026-12');
  assert.deepEqual([november.terms.careCents,november.terms.careAgreementRef,november.terms.aiUsage,november.acceptance?.subject],['12500','synthetic-care-agreement',{billing:'resale',markupBasisPoints:3000,termsReference:RESALE.termsReference},`standing:${digest(anchor)}`]);
  assert.deepEqual([december.terms.careCents,!!december.terms.aiUsage,december.acceptance?.subject],['12500',true,`standing:${digest(anchor)}`]);
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind='ai_resale_terms_accepted'").length,1);
  const oct=await close('2026-10');
  assert.deepEqual([oct.ai,oct.invoice.totalCents,oct.invoice.status],['included','0','nothing_due']);
  assert.deepEqual(modelvia.calls,[]);
  // 2 December: November is care A$125 plus November's Modelvia invoice; September's and October's are absorbed, never consolidated.
  f.setTime(at('2026-12-02T00:00:00Z'));
  const nov=await close('2026-11');
  assert.deepEqual([nov.ai,nov.invoice.totalCents,nov.invoice.gstCents,nov.invoice.status,nov.invoice.dueAt],['consolidated','21300','1936','unpaid',f.now()+7*86_400_000]);
  const novInvoice=JSON.parse(f.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',nov.invoice.id)!.body) as Invoice;
  assert.deepEqual(novInvoice.lines.map(l=>[l.description,l.amountCents,l.gstCents,l.modelviaInvoice??null]),[['RealBud software and routine maintenance — monthly care','12500','1136',null],['AI usage — Synthetic model — 1 request','8800','800','CI-000011']]);
  assert.deepEqual(novInvoice.aiUsage!.modelviaInvoices.map(i=>i.id),['CI-000011']);
  assert.deepEqual(f.db.all<{modelvia_invoice:string}>('SELECT modelvia_invoice FROM office_ai_consolidations').map(r=>r.modelvia_invoice),['CI-000011']);
  assert.deepEqual([...absorbedAiPeriods(f.ledger,f.tenant.companyId)].sort(),['2026-09','2026-10']);
  assert.deepEqual(modelvia.calls,['month:2026-11','invoice:CI-000011']);
  assert.deepEqual(plans.view(f.tenant.companyId).months.map(m=>[m.period,m.state,m.invoiceId!==null]),[['2026-09','closed',true],['2026-10','closed',true],['2026-11','closed',true],['2026-12','standing',false],['2027-01','standing',false]]);
  // Append-only: neither a plan nor an absorption can change or disappear; the chain verifies.
  for(const sql of ["UPDATE billing_plans SET body='{}'",'DELETE FROM billing_plans',"UPDATE office_ai_absorptions SET body='{}'",'DELETE FROM office_ai_absorptions']) assert.throws(()=>f.db.run(sql),/immutable_record/,sql);
  assert.equal(operatorInvoice(billing,septInvoice).status,'nothing_due');
  f.db.verify();
});

test('an included month closed under earlier terms is still never billed: the accepted plan on the resale month\'s terms names it',async()=>{
  const {f,plans,close,accept,billing}=office();
  // September was published and closed by the operator command before any plan existed.
  const legacy=billing.commercialTerms!.publish(careTermsDraft(f,'care-v1','0'));
  billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',legacy.digest);
  f.setTime(at('2026-10-05T00:00:00Z'));
  await close('2026-09');
  plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN});
  accept('2026-10');
  f.setTime(at('2026-12-02T00:00:00Z'));
  await close('2026-10');
  const nov=await close('2026-11');
  assert.deepEqual(JSON.parse(f.db.get<{body:string}>('SELECT body FROM invoices WHERE id=?',nov.invoice.id)!.body).aiUsage.modelviaInvoices.map((i:{id:string})=>i.id),['CI-000011']);
});

test('a plan change is a new version: closed months stay, unclosed months are republished and wait for the owner; the same content is not a new version',async()=>{
  const {f,plans,close,list,accept,terms}=office();
  plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN});
  accept('2026-09');
  f.setTime(at('2026-10-05T00:00:00Z'));
  const sept=await close('2026-09');
  // Idempotent: the same plan again (markup stated explicitly at the default) is the current version.
  const same=plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN,markupBasisPoints:3000});
  assert.deepEqual([same.plan!.version,same.rollForward.published,f.db.all('SELECT seq FROM billing_plans').length],['plan-v1',[],1]);
  // A price change: version 2. September's invoice and terms are untouched; October and November follow v2 unaccepted.
  const changed=plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN,careCents:'15000',tradingName:'Fictional Agency A Realty'});
  assert.deepEqual([changed.plan!.version,changed.acceptance.state,changed.rollForward.published],['plan-v2','awaiting_owner',['2026-10','2026-11']]);
  assert.deepEqual(changed.months.map(m=>[m.period,m.version,m.careCents,m.state]),[['2026-09','plan-v1','0','closed'],['2026-10','plan-v2','0','published'],['2026-11','plan-v2','15000','published']]);
  assert.equal(terms.current(f.owner,'2026-09').terms.version,'plan-v1-2026-09');
  assert.equal(terms.current(f.owner,'2026-10').terms.version,'plan-v2-2026-10');
  assert.equal(terms.current(f.owner,'2026-10').terms.customer.tradingName,'Fictional Agency A Realty');
  assert.deepEqual([list('2026-10').blocker,list('2026-09').invoiceId],['plan_awaiting_owner',sept.invoice.id]);
  f.setTime(at('2026-11-02T00:00:00Z'));
  await assert.rejects(close('2026-10'),/plan_awaiting_owner/);
  const anchor2=accept('2026-10');
  assert.deepEqual([terms.current(f.owner,'2026-11').acceptance?.subject,plans.view(f.tenant.companyId).acceptance.acceptedAt],[`standing:${digest(anchor2)}`,anchor2.acceptedAt]);
  const oct=await close('2026-10');
  assert.deepEqual([oct.ai,oct.invoice.totalCents,oct.invoice.officeName],['included','0','Fictional Agency A Realty']);
  f.db.verify();
});

test('standing acceptances are only ever created for months of an accepted plan version, under a genuine anchor',()=>{
  const {f,plans,accept,terms}=office();
  plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN});
  const {publishedAt:_published,...october}=terms.current(f.owner,'2026-10').terms;
  const forged:CommercialAcceptance={companyId:f.tenant.companyId,period:'2026-09',version:'plan-v1-2026-09',digest:terms.current(f.owner,'2026-09').digest,subject:f.owner.subject,acceptedAt:f.now()};
  // Month 3 as the plan states it: care A$125 and AI resale at the plan's markup.
  const november={...october,period:'2026-11',version:'plan-v1-2026-11',careCents:'12500',careAgreementRef:'synthetic-care-agreement',aiUsage:{billing:'resale' as const,markupBasisPoints:3000,termsReference:RESALE.termsReference}};
  // No acceptance exists yet: an anchor that is not stored is refused, and nothing is published.
  assert.throws(()=>terms.publish(november,{anchor:forged}),/billing_plan_anchor_invalid/);
  assert.equal(f.db.all("SELECT seq FROM commercial_terms WHERE period='2026-11'").length,0);
  const anchor=accept('2026-09');
  // A standing acceptance cannot anchor another; the owner's can.
  const standing=terms.current(f.owner,'2026-10').acceptance!;
  assert.throws(()=>terms.publish(november,{anchor:standing}),/billing_plan_anchor_invalid/);
  const {billingPlan:_block,...unplanned}=november;
  assert.throws(()=>terms.publish(unplanned,{anchor}),/billing_plan_terms_invalid/);
  const published=terms.publish(november,{anchor});
  assert.equal(published.acceptance?.subject,`standing:${digest(anchor)}`);
  assert.equal(terms.accepted(f.tenant.companyId,'2026-11').acceptance.subject,`standing:${digest(anchor)}`);
  // Terms that contradict their plan block are refused.
  const {aiUsage:_ai,...withoutAi}=november;
  assert.throws(()=>terms.publish({...withoutAi,period:'2026-12',version:'x-12'}),/billing_plan_terms_invalid/);
  assert.throws(()=>terms.publish({...november,period:'2026-12',version:'x-12',careCents:'0',careAgreementRef:null}),/billing_plan_terms_invalid/);
  assert.throws(()=>terms.publish({...november,period:'2026-12',version:'x-12',aiUsage:{...november.aiUsage,markupBasisPoints:2500}}),/billing_plan_terms_invalid/);
  assert.throws(()=>terms.publish({...november,period:'2026-08',version:'x-08'}),/billing_plan_terms_invalid/);
  // Only the owner's acceptance and the plan roll-forward create acceptance rows.
  assert.deepEqual(f.db.all<{period:string;body:string}>('SELECT period,body FROM commercial_acceptances ORDER BY period').map(r=>[r.period,isStandingAcceptance(JSON.parse(r.body))]),[['2026-09',false],['2026-10',true],['2026-11',true]]);
  f.db.verify();
});

test('blockers and refusals: no plan for an office invoiced before, the plan awaiting the owner, unconfigured deployment, a client-funded office, the internal account, bad bodies',async()=>{
  const {f,plans,billing,close,list}=office({clientFunded:['company-free']});
  // Legacy office: September closed from command-published terms; October has nothing and no plan.
  const legacy=billing.commercialTerms!.publish(careTermsDraft(f,'care-v1','12500'));
  billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',legacy.digest);
  f.setTime(at('2026-10-05T00:00:00Z'));
  assert.equal(list('2026-10').blocker,'terms_not_accepted');
  await close('2026-09');
  f.setTime(at('2026-11-02T00:00:00Z'));
  assert.deepEqual([list('2026-10').state,list('2026-10').blocker],['blocked','no_billing_plan']);
  await assert.rejects(close('2026-10'),/no_billing_plan/);
  // A plan from October: published for October and November (next month is December), awaiting the owner.
  const view=plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN,startPeriod:'2026-10'});
  assert.deepEqual(view.rollForward.published,['2026-10','2026-11','2026-12']);
  assert.equal(list('2026-10').blocker,'plan_awaiting_owner');
  // Refusals by code.
  f.ledger.provisionTenant({...f.tenant,companyId:'company-free',licenseId:'license-free'});
  assert.throws(()=>plans.set(OPERATOR,{companyId:'company-free',...AUSTIN}),/client_funded_office_ai_not_billable/);
  assert.deepEqual(plans.set(OPERATOR,{companyId:'company-free',...AUSTIN,aiBilling:'included'}).plan!.aiBilling,'included');
  assert.throws(()=>plans.set(OPERATOR,{companyId:INTERNAL,...AUSTIN}),/internal_usage_not_billable/);
  assert.throws(()=>plans.set(OPERATOR,{companyId:'company-unknown',...AUSTIN}),/tenant_unavailable/);
  for(const [body,code] of [
    [{...AUSTIN,startPeriod:'2026-05'},/billing_plan_before_go_live/],[{...AUSTIN,startPeriod:'2026-9'},/invalid_billing_plan/],
    [{...AUSTIN,includedMonths:25},/invalid_billing_plan/],[{...AUSTIN,includedMonths:'2'},/invalid_billing_plan/],[{...AUSTIN,careCents:'125.00'},/invalid_billing_plan/],
    [{...AUSTIN,aiBilling:'free'},/invalid_billing_plan/],[{...AUSTIN,markupBasisPoints:10001},/invalid_markup/],[{...AUSTIN,aiBilling:'included',markupBasisPoints:0},/invalid_billing_plan/],
    [{...AUSTIN,billingEmail:'Accounts <a@b.example>'},/commercial_billing_email_invalid/],[{...AUSTIN,tradingName:'bad\u0007name'},/commercial_customer_invalid/],
    [{...AUSTIN,version:'plan-v9'},/invalid_fields/],[{...AUSTIN,seller:{}},/invalid_fields/],
  ] as [Record<string,unknown>,RegExp][]) assert.throws(()=>plans.set(OPERATOR,{companyId:f.tenant.companyId,...body}),code,JSON.stringify(body));
  // Unconfigured deployment: the plan cannot be set, and an existing plan's months cannot be published.
  const missing=office({config:{unavailable:'billing_plan_unconfigured:REALBUD_SELLER_ABN'}});
  assert.throws(()=>missing.plans.set(OPERATOR,{companyId:missing.f.tenant.companyId,...AUSTIN}),/billing_plan_unconfigured:REALBUD_SELLER_ABN/);
  const noResale=office({resale:false});
  assert.throws(()=>noResale.plans.set(OPERATOR,{companyId:noResale.f.tenant.companyId,...AUSTIN}),/billing_plan_unconfigured:REALBUD_MODELVIA_RESALE_TERMS_REFERENCE/);
  // An inactive office cannot be planned; a plan whose office was suspended later shows the refusal as its blocker.
  f.ledger.setService(f.tenant.companyId,false,f.tenant.serviceExpiresAt,'synthetic-suspension');
  assert.throws(()=>plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN,careCents:'1'}),/commercial_tenant_inactive/);
  f.setTime(at('2027-01-02T00:00:00Z'));
  assert.deepEqual([plans.rollForward(f.tenant.companyId).blocker,list('2027-01').blocker],['commercial_tenant_inactive','commercial_tenant_inactive']);
});

test('the daily roll-forward publishes next month for every planned office with its standing acceptance, and is idempotent',()=>{
  const {f,plans,accept,terms}=office();
  plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN});
  const anchor=accept('2026-09');
  f.setTime(at('2026-10-20T00:00:00Z'));
  assert.deepEqual(plans.rollForwardAll(),[{companyId:f.tenant.companyId,published:['2026-11'],blocker:null}]);
  assert.deepEqual(plans.rollForwardAll(),[{companyId:f.tenant.companyId,published:[],blocker:null}]);
  const november=terms.current(f.owner,'2026-11');
  assert.deepEqual([november.terms.careCents,november.terms.aiUsage?.markupBasisPoints,november.acceptance?.subject],['12500',3000,`standing:${digest(anchor)}`]);
  assert.deepEqual(terms.accepted(f.tenant.companyId,'2026-11').digest,november.digest);
  f.db.verify();
});

test('the portal presentation shows the plan in the owner\'s words and the stored terms exactly (markup included), so the digest checks',()=>{
  const {f,plans,accept,terms}=office();
  plans.set(OPERATOR,{companyId:f.tenant.companyId,...AUSTIN});
  const september=presentCommercialTerms(terms.current(f.owner,'2026-09'));
  assert.deepEqual(september.plan,{version:'plan-v1',startPeriod:'2026-09',includedMonths:2,includedUntil:'2026-10',careCents:'12500',careFrom:'2026-11',aiBilling:'resale',aiBilledFrom:'2026-11',month:1,included:true,accepted:false});
  assert.deepEqual(september.terms,terms.current(f.owner,'2026-09').terms);
  assert.equal(september.digest,terms.current(f.owner,'2026-09').digest);
  accept('2026-09');
  f.setTime(at('2026-10-20T00:00:00Z'));
  plans.rollForward(f.tenant.companyId);
  const november=presentCommercialTerms(terms.current(f.owner,'2026-11'));
  assert.deepEqual([november.plan!.month,november.plan!.included,november.plan!.accepted,november.terms.aiUsage,november.terms.careCents],[3,false,true,{billing:'resale',markupBasisPoints:3000,termsReference:RESALE.termsReference},'12500']);
  // Command-published terms present unchanged, markup included.
  const {billingPlan:_plan,...base}=terms.current(f.owner,'2026-09').terms;
  const legacy=presentCommercialTerms({terms:{...base,aiUsage:{billing:'resale',markupBasisPoints:2500,termsReference:'ref'}},digest:'x'.repeat(64),acceptance:null});
  assert.deepEqual([legacy.plan,legacy.terms.aiUsage,'billingPlan' in legacy.terms],[null,{billing:'resale',markupBasisPoints:2500,termsReference:'ref'},false]);
});
