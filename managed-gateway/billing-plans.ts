/**
 * Billing plans: accept once, roll forward (owner decision, 29 September 2026,
 * `docs/decisions/2026-09-29-operator-billing.md`, second part).
 *
 * The operator sets ONE plan per office (append-only versions, `billing_plans`):
 * the go-live month, how many months are included (no care fee, AI included),
 * and after them the monthly care fee and whether AI is resold or included.
 * The gateway publishes each month's commercial terms from the plan
 * (`commercial-terms.ts`, with the digest-bound `billingPlan` block), from the
 * start month through next month, lazily (close list, close, portal terms read)
 * and by the server's daily timer. The billing owner accepts any one month of a
 * plan version through the portal as before; that acceptance is the version's
 * ANCHOR, and every other month of the version gets a standing acceptance
 * (`standing:<anchor digest>`) in the same transaction as its terms, or as the
 * anchor when the terms were published first. A plan change is a new version:
 * closed months are untouched, every unclosed month is republished and waits for
 * the owner again (agreement clause 7).
 *
 * Seller, tax and reference ids come from the deployment (`REALBUD_SELLER_*`,
 * `REALBUD_TAX_TREATMENT_REF`, `REALBUD_CUSTOMER_TERMS_REF`,
 * `REALBUD_CARE_AGREEMENT_REF`), the customer identity from the office's
 * entitlement record; nothing legal comes from a browser body. Clients never
 * see markup basis points: `presentCommercialTerms` strips them.
 */
import { canonical, exact, GatewayError, id, object, requireThat } from './contracts.ts';
import { digest } from './ledger.ts';
import { periodAt } from './money.ts';
import type { BillingService } from './billing.ts';
import { includedMonth, isStandingAcceptance, MAX_INCLUDED_MONTHS, MAX_OFFICE_MARKUP_BASIS_POINTS, planMonthIndex, validBillingEmail,
  type BillingPlanTerms, type CommercialAcceptance, type CommercialTerms, type CommercialTermsDraft, type CommercialTermsStore, type SellerBasis } from './commercial-terms.ts';
import type { OperatorPrincipal } from './operator-token.ts';

export interface BillingPlan {
  companyId:string; version:string; startPeriod:string; includedMonths:number;
  /** After the included months. */
  careCents:string; aiBilling:'resale'|'included';
  /** Resale only; never shown to the office. */
  markupBasisPoints?:number; termsReference?:string;
  billingEmail?:string; tradingName?:string;
  setBy:string; setAt:number;
}
export type BillingPlanMonthState='unpublished'|'published'|'accepted'|'standing'|'closed';
export interface BillingPlanMonth { period:string; version:string|null; careCents:string; aiBilled:boolean; included:boolean; state:BillingPlanMonthState; invoiceId:string|null }
export interface BillingPlanView {
  plan:BillingPlan|null;
  acceptance:{state:'none'|'awaiting_owner'|'accepted';acceptedAt:number|null};
  months:BillingPlanMonth[];
  /** What this read published, and the code that stopped it (a close-list blocker). */
  rollForward:{published:string[];blocker:string|null};
}
/** The deployment's seller basis and reference ids, checked as `publish` checks them. */
export interface BillingPlanConfig { seller:SellerBasis; tax:CommercialTerms['tax']; sellerVerificationRef:string; customerTermsRef:string; careAgreementRef:string }
export const BILLING_PLAN_ENV=['REALBUD_SELLER_LEGAL_NAME','REALBUD_SELLER_ABN','REALBUD_SELLER_ADDRESS','REALBUD_TAX_TREATMENT_REF','REALBUD_SELLER_VERIFICATION_REF','REALBUD_CUSTOMER_TERMS_REF','REALBUD_CARE_AGREEMENT_REF'] as const;

const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
const meaningful=(value:string,max:number)=>value.trim().length>0 && value.length<=max && !/[\u0000-\u001f\u007f]/.test(value);
const unconfigured=(name:string)=>({unavailable:`billing_plan_unconfigured:${name}`});
const isId=(value:string)=>/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value);

/** Month arithmetic on `YYYY-MM`. */
export function addMonths(period:string,months:number):string {
  const [year,month]=period.split('-').map(Number), total=year*12+(month-1)+months;
  return `${Math.floor(total/12)}-${String(total%12+1).padStart(2,'0')}`;
}
export const nextPeriod=(now:number)=>addMonths(periodAt(now),1);

/** From the environment: every variable present and well formed, else the code
 * naming the first missing one (never its value). In live collection the seller
 * basis must be the reviewed one (`REALBUD_SELLER_BASIS_DIGEST`), or every
 * checkout of a plan invoice would be refused `seller_basis_not_approved`. */
export function composeBillingPlanConfig(env:NodeJS.ProcessEnv):BillingPlanConfig|{unavailable:string} {
  const value=(name:string)=>(env[name]??'').trim();
  for(const name of BILLING_PLAN_ENV) if(!value(name)) return unconfigured(name);
  if(!meaningful(value('REALBUD_SELLER_LEGAL_NAME'),200)) return unconfigured('REALBUD_SELLER_LEGAL_NAME');
  if(!/^\d{11}$/.test(value('REALBUD_SELLER_ABN'))) return unconfigured('REALBUD_SELLER_ABN');
  if(!meaningful(value('REALBUD_SELLER_ADDRESS'),500)) return unconfigured('REALBUD_SELLER_ADDRESS');
  if(!meaningful(value('REALBUD_TAX_TREATMENT_REF'),160)) return unconfigured('REALBUD_TAX_TREATMENT_REF');
  for(const name of ['REALBUD_SELLER_VERIFICATION_REF','REALBUD_CUSTOMER_TERMS_REF','REALBUD_CARE_AGREEMENT_REF'] as const) if(!isId(value(name))) return unconfigured(name);
  const config:BillingPlanConfig={seller:{legalName:value('REALBUD_SELLER_LEGAL_NAME'),product:'RealBud',abn:value('REALBUD_SELLER_ABN'),address:value('REALBUD_SELLER_ADDRESS'),gstRegistered:true},
    tax:{currency:'AUD',gstInclusive:true,gstBasisPoints:1000,treatmentRef:value('REALBUD_TAX_TREATMENT_REF')},
    sellerVerificationRef:value('REALBUD_SELLER_VERIFICATION_REF'),customerTermsRef:value('REALBUD_CUSTOMER_TERMS_REF'),careAgreementRef:value('REALBUD_CARE_AGREEMENT_REF')};
  const reviewed=value('REALBUD_SELLER_BASIS_DIGEST');
  if(reviewed && reviewed!==digest({seller:config.seller,tax:config.tax,sellerVerificationRef:config.sellerVerificationRef})) return unconfigured('REALBUD_SELLER_BASIS_DIGEST');
  return config;
}

/** The office's plan versions, append-only. Created on first use, like `office_ai_consolidations`. */
function ensurePlanTable(billing:BillingService) {
  billing.ledger.db.sql.exec(`CREATE TABLE IF NOT EXISTS billing_plans (seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, version TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(tenant,version));
    CREATE TRIGGER IF NOT EXISTS immutable_billing_plans_UPDATE BEFORE UPDATE ON billing_plans BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_billing_plans_DELETE BEFORE DELETE ON billing_plans BEGIN SELECT RAISE(ABORT,'immutable_record'); END;`);
}
/** The content a new version is compared against: everything but its identity. */
const content=(plan:Omit<BillingPlan,'companyId'|'version'|'setBy'|'setAt'>)=>canonical({startPeriod:plan.startPeriod,includedMonths:plan.includedMonths,careCents:plan.careCents,aiBilling:plan.aiBilling,
  markupBasisPoints:plan.markupBasisPoints,termsReference:plan.termsReference,billingEmail:plan.billingEmail,tradingName:plan.tradingName});

export class BillingPlans {
  readonly billing:BillingService;
  private readonly config:BillingPlanConfig|{unavailable:string};
  private readonly resale:{clientMarkupBasisPoints:number;termsReference:string}|undefined;
  private readonly resaleUnavailable:string;
  private readonly clientFundedCompanies:ReadonlySet<string>;
  constructor(options:{billing:BillingService;config:BillingPlanConfig|{unavailable:string};resale?:{clientMarkupBasisPoints:number;termsReference:string};resaleUnavailable?:string;clientFundedCompanies:ReadonlySet<string>}) {
    this.billing=options.billing;this.config=options.config;this.resale=options.resale;this.clientFundedCompanies=options.clientFundedCompanies;
    this.resaleUnavailable=options.resaleUnavailable??'billing_plan_unconfigured:REALBUD_MODELVIA_RESALE_TERMS_REFERENCE';
  }
  private get terms():CommercialTermsStore { requireThat(this.billing.commercialTerms,'commercial_terms_unavailable',503); return this.billing.commercialTerms; }
  /** The office's current plan version, if any. */
  current(companyId:string):BillingPlan|undefined {
    id(companyId); ensurePlanTable(this.billing);
    const row=this.billing.ledger.db.get<{body:string}>('SELECT body FROM billing_plans WHERE tenant=? ORDER BY seq DESC LIMIT 1',companyId);
    return row?JSON.parse(row.body) as BillingPlan:undefined;
  }
  /** Every office with a plan. */
  companies():string[] {
    ensurePlanTable(this.billing);
    return this.billing.ledger.db.all<{tenant:string}>('SELECT DISTINCT tenant FROM billing_plans ORDER BY tenant').map(row=>row.tenant);
  }

  /** Set the office's plan. The same content as the current version returns it
   * (no new version); different content is a new version that every unclosed
   * month follows and the owner must accept. Then rolls forward. */
  set(operator:OperatorPrincipal,value:unknown):BillingPlanView {
    requireThat(operator && typeof operator.subject==='string' && operator.subject.length>0,'operator_unauthenticated',401);
    object(value);
    exact(value,['companyId','startPeriod','includedMonths','careCents','aiBilling',...(value.markupBasisPoints!==undefined?['markupBasisPoints']:[]),...(value.billingEmail!==undefined?['billingEmail']:[]),...(value.tradingName!==undefined?['tradingName']:[])]);
    const terms=this.terms; id(value.companyId); const companyId=value.companyId;
    requireThat('unavailable' in this.config===false,('unavailable' in this.config?this.config.unavailable:''),503);
    requireThat(companyId!==terms.internalCompanyId,'internal_usage_not_billable',403);
    const ledger=this.billing.ledger, tenant=ledger.tenant(companyId);
    requireThat(tenant.billingMode!=='internal_cost','internal_usage_not_billable',403);
    requireThat(tenant.active,'commercial_tenant_inactive',409);
    requireThat(typeof value.startPeriod==='string' && MONTH.test(value.startPeriod),'invalid_billing_plan');
    requireThat(value.startPeriod>=periodAt(tenant.goLiveAt),'billing_plan_before_go_live',409);
    requireThat(Number.isSafeInteger(value.includedMonths) && (value.includedMonths as number)>=0 && (value.includedMonths as number)<=MAX_INCLUDED_MONTHS,'invalid_billing_plan');
    requireThat(typeof value.careCents==='string' && /^(0|[1-9]\d{0,12})$/.test(value.careCents),'invalid_billing_plan');
    requireThat(value.aiBilling==='resale' || value.aiBilling==='included','invalid_billing_plan');
    let ai:{markupBasisPoints:number;termsReference:string}|undefined;
    if(value.aiBilling==='resale') {
      requireThat(!this.clientFundedCompanies.has(companyId),'client_funded_office_ai_not_billable',409);
      requireThat(this.resale,this.resaleUnavailable,503);
      const markup=value.markupBasisPoints??this.resale!.clientMarkupBasisPoints;
      requireThat(Number.isSafeInteger(markup) && (markup as number)>=0 && (markup as number)<=MAX_OFFICE_MARKUP_BASIS_POINTS,'invalid_markup');
      ai={markupBasisPoints:markup as number,termsReference:this.resale!.termsReference};
    } else requireThat(value.markupBasisPoints===undefined,'invalid_billing_plan');
    requireThat(value.billingEmail===undefined || validBillingEmail(value.billingEmail),'commercial_billing_email_invalid',409);
    requireThat(value.tradingName===undefined || (typeof value.tradingName==='string' && meaningful(value.tradingName,200)),'commercial_customer_invalid',409);
    const proposed:Omit<BillingPlan,'companyId'|'version'|'setBy'|'setAt'>={startPeriod:value.startPeriod,includedMonths:value.includedMonths as number,careCents:value.careCents,aiBilling:value.aiBilling,
      ...(ai??{}),...(value.billingEmail!==undefined?{billingEmail:value.billingEmail as string}:{}),...(value.tradingName!==undefined?{tradingName:value.tradingName as string}:{})};
    ensurePlanTable(this.billing);
    ledger.db.transaction(()=>{
      const current=this.current(companyId);
      if(current && content(current)===content(proposed)) return;
      const count=ledger.db.get<{n:number}>('SELECT COUNT(*) AS n FROM billing_plans WHERE tenant=?',companyId)!.n;
      const plan:BillingPlan={companyId,version:`plan-v${count+1}`,...proposed,setBy:operator.subject,setAt:ledger.now()};
      ledger.db.run('INSERT INTO billing_plans(tenant,version,body) VALUES(?,?,?)',companyId,plan.version,canonical(plan));
      ledger.db.append(companyId,'billing_plan_set',null,ledger.now(),{...plan,previousVersion:current?.version??null});
    });
    return this.view(companyId);
  }

  /** The plan, its acceptance and each month from the start through next month. Rolls forward first. */
  view(companyId:string):BillingPlanView {
    const rolled=this.rollForward(companyId);
    const plan=this.current(companyId);
    if(!plan) return {plan:null,acceptance:{state:'none',acceptedAt:null},months:[],rollForward:rolled};
    const ledger=this.billing.ledger, terms=this.terms;
    const anchor=terms.planAcceptance(companyId,plan.version);
    const periods=ledger.db.all<{period:string}>('SELECT DISTINCT period FROM commercial_terms WHERE tenant=? AND period>=? ORDER BY period',companyId,plan.startPeriod).map(row=>row.period);
    const through=[nextPeriod(ledger.now()),...periods].sort().at(-1)!;
    const months:BillingPlanMonth[]=[];
    for(let period=plan.startPeriod;period<=through;period=addMonths(period,1)) {
      const invoice=ledger.db.get<{id:string}>('SELECT id FROM invoices WHERE tenant=? AND period=?',companyId,period);
      const latest=ledger.db.get<{version:string;body:string}>('SELECT version,body FROM commercial_terms WHERE tenant=? AND period=? ORDER BY seq DESC LIMIT 1',companyId,period);
      const month=planMonthIndex(plan.startPeriod,period), planned=month<=plan.includedMonths;
      if(!latest) { months.push({period,version:null,careCents:planned?'0':plan.careCents,aiBilled:!planned && plan.aiBilling==='resale',included:planned,state:'unpublished',invoiceId:null}); continue; }
      const current=JSON.parse(latest.body) as CommercialTerms;
      const acceptance=ledger.db.get<{body:string}>('SELECT body FROM commercial_acceptances WHERE tenant=? AND period=? AND version=?',companyId,period,latest.version);
      const state:BillingPlanMonthState=invoice?'closed':!acceptance?'published':isStandingAcceptance(JSON.parse(acceptance.body) as CommercialAcceptance)?'standing':'accepted';
      months.push({period,version:current.billingPlan?.version??null,careCents:current.careCents,aiBilled:!!current.aiUsage,included:includedMonth(current),state,invoiceId:invoice?.id??null});
    }
    return {plan,acceptance:anchor?{state:'accepted',acceptedAt:anchor.acceptedAt}:{state:'awaiting_owner',acceptedAt:null},months,rollForward:rolled};
  }

  /** Publish the plan's months from its start through `through` (at least next
   * month) that are not closed and not yet published from the current version,
   * each with its standing acceptance once the version has its anchor. Never
   * throws: the first refusal is returned as a code, the way the close list
   * shows it. */
  rollForward(companyId:string,through?:string):{published:string[];blocker:string|null} {
    const plan=this.current(companyId);
    const published:string[]=[];
    if(!plan) return {published,blocker:null};
    const ledger=this.billing.ledger, last=[nextPeriod(ledger.now()),through??''].sort().at(-1)!;
    try {
      const terms=this.terms;
      let anchor:CommercialAcceptance|undefined;
      for(let period=plan.startPeriod;period<=last;period=addMonths(period,1)) {
        if(ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND period=?',companyId,period)) continue;
        const version=`${plan.version}-${period}`;
        if(ledger.db.get('SELECT seq FROM commercial_terms WHERE tenant=? AND period=? AND version=?',companyId,period,version)) continue;
        requireThat('unavailable' in this.config===false,('unavailable' in this.config?this.config.unavailable:''),503);
        anchor??=terms.planAcceptance(companyId,plan.version);
        terms.publish(this.draft(plan,period,version),anchor?{anchor}:undefined);
        published.push(period);
      }
      return {published,blocker:null};
    } catch(error) { return {published,blocker:error instanceof GatewayError?error.code:'billing_plan_roll_forward_failed'}; }
  }
  /** Every office with a plan, for the daily timer. */
  rollForwardAll():{companyId:string;published:string[];blocker:string|null}[] {
    return this.companies().map(companyId=>({companyId,...this.rollForward(companyId)}));
  }
  /** One month's terms from the plan: the month's own charge, the customer from
   * the entitlement record, the seller basis from the deployment. */
  private draft(plan:BillingPlan,period:string,version:string):CommercialTermsDraft {
    const config=this.config as BillingPlanConfig, tenant=this.billing.ledger.tenant(plan.companyId);
    const included=planMonthIndex(plan.startPeriod,period)<=plan.includedMonths, careCents=included?'0':plan.careCents;
    const resale=!included && plan.aiBilling==='resale';
    const billingPlan:BillingPlanTerms={version:plan.version,startPeriod:plan.startPeriod,includedMonths:plan.includedMonths,careCents:plan.careCents,aiBilling:plan.aiBilling,
      ...(plan.aiBilling==='resale'?{markupBasisPoints:plan.markupBasisPoints!,termsReference:plan.termsReference!}:{})};
    return {companyId:plan.companyId,period,version,
      customer:{name:tenant.customerName,address:tenant.customerAddress,...(tenant.customerAbn!==undefined?{abn:tenant.customerAbn}:{}),...(plan.tradingName!==undefined?{tradingName:plan.tradingName}:{}),...(plan.billingEmail!==undefined?{billingEmail:plan.billingEmail}:{})},
      seller:{...config.seller},tax:{...config.tax},sellerVerificationRef:config.sellerVerificationRef,customerTermsRef:config.customerTermsRef,
      careCents,careAgreementRef:careCents==='0'?null:config.careAgreementRef,rateCards:[],
      ...(resale?{aiUsage:{billing:'resale',markupBasisPoints:plan.markupBasisPoints!,termsReference:plan.termsReference!}}:{}),billingPlan};
  }

  /** The close list's plan blockers for one month, or null when the ordinary
   * terms resolution decides. `plan_awaiting_owner`: the month's current terms
   * come from a plan version the owner has not accepted. `no_billing_plan`: no
   * plan and nothing published for the month, for an office invoiced before. */
  blocker(companyId:string,period:string):string|null {
    const ledger=this.billing.ledger, plan=this.current(companyId);
    const latest=ledger.db.get<{version:string;body:string}>('SELECT version,body FROM commercial_terms WHERE tenant=? AND period=? ORDER BY seq DESC LIMIT 1',companyId,period);
    if(!plan) return !latest && ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND period<?',companyId,period)?'no_billing_plan':null;
    if(!latest) return null;
    const current=JSON.parse(latest.body) as CommercialTerms;
    if(!current.billingPlan) return null;
    return ledger.db.get('SELECT digest FROM commercial_acceptances WHERE tenant=? AND period=? AND version=?',companyId,period,latest.version)?null:'plan_awaiting_owner';
  }
}

/** What the portal shows: the office's terms without markup basis points, and
 * the plan they belong to in the owner's words (included months, the monthly fee
 * from which month, AI billed after each month from which month). The digest is
 * the stored terms' digest, which the owner's acceptance names. */
export function presentCommercialTerms(current:{terms:CommercialTerms;digest:string;acceptance:CommercialAcceptance|null}) {
  // The owner sees exactly the terms they accept, markup included (the invite
  // terms already state it), so the website can check the stored digest.
  // Wholesale cost is never on the terms.
  const {terms}=current, plan=terms.billingPlan;
  const presented=terms;
  const after=plan?addMonths(plan.startPeriod,plan.includedMonths):null;
  return {terms:presented,digest:current.digest,acceptance:current.acceptance,
    plan:plan?{version:plan.version,startPeriod:plan.startPeriod,includedMonths:plan.includedMonths,includedUntil:plan.includedMonths>0?addMonths(plan.startPeriod,plan.includedMonths-1):null,
      careCents:plan.careCents,careFrom:plan.careCents==='0'?null:after,aiBilling:plan.aiBilling,aiBilledFrom:plan.aiBilling==='resale'?after:null,
      month:planMonthIndex(plan.startPeriod,terms.period),included:includedMonth(terms),accepted:!!current.acceptance}:null};
}
export type PresentedCommercialTerms=ReturnType<typeof presentCommercialTerms>;
