/** A separately accepted, month-specific customer contract for the care fee.
 * It names the seller, the customer, the GST basis and the exact monthly care
 * amount, and authorises collection of the closed care invoice. AI pricing is
 * Modelvia's (owner decision, 24 September 2026): these terms carry no AI rate,
 * and nothing here reads or requires a gateway rate card. */
import { canonical, exact, id, object, requireThat, type PortalPrincipal } from './contracts.ts';
import { digest, type UsageLedger } from './ledger.ts';
import type { Invoice } from './billing.ts';

export interface SellerBasis { legalName:string; product:'RealBud'; abn:string; address:string; gstRegistered:true }
export interface CommercialTerms {
  companyId:string; period:string; version:string;
  /** `tradingName` is optional and shown on invoices beside the registered
   * name; name, address and ABN must match the office's entitlement record. */
  customer:{name:string;address:string;abn?:string;tradingName?:string};
  seller:SellerBasis;
  tax:{currency:'AUD';gstInclusive:true;gstBasisPoints:1000;treatmentRef:string};
  sellerVerificationRef:string; customerTermsRef:string;
  careCents:string; careAgreementRef:string|null;
  /** Kept in the persisted shape for compatibility and normally empty. AI rates
   * are Modelvia's: entries are references only and never gate acceptance,
   * close or collection. */
  rateCards:{version:string;digest:string}[];
  /** Present only for an office that buys its AI through RealBud (owner decision,
   * 26 September 2026): the billing owner's acceptance of these terms is the
   * office's acceptance of AI usage at Modelvia's price plus this markup, billed
   * as one "AI usage" line on this month's RealBud invoice from the office's
   * finalized Modelvia customer invoice (`office-ai-billing.ts`). Absent (every
   * earlier terms row, and client-funded offices): the invoice is care only. An
   * absent field leaves the terms digest unchanged (`canonical`). */
  aiUsage?:AiUsageTerms;
  publishedAt:number;
}
/** `markupBasisPoints` is THIS office's accepted markup (0..10000, i.e. 0-100%).
 * The deployment's REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS is only the
 * default for new terms (`office-ai-terms.ts`); an operator's proposed markup for
 * the office takes its place, and neither applies until the office accepts. */
export interface AiUsageTerms { billing:'resale'; markupBasisPoints:number; termsReference:string }
/** Largest accepted per-office markup: 100%. */
export const MAX_OFFICE_MARKUP_BASIS_POINTS=10_000;
export type CommercialTermsDraft=Omit<CommercialTerms,'publishedAt'>;
export interface CommercialAcceptance { companyId:string;period:string;version:string;digest:string;subject:string;acceptedAt:number }
export interface CollectionInvoiceBinding {invoiceId:string;companyId:string;period:string;invoiceDigest:string;termsVersion:string;termsDigest:string;acceptanceDigest:string;sellerBasisDigest:string;amountCents:string}
const hex=(value:string)=>/^[a-f0-9]{64}$/.test(value);
const month=(value:string)=>/^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const meaningful=(value:string,max=500)=>typeof value==='string' && value.trim().length>0 && value.length<=max;

export class CommercialTermsStore {
  readonly ledger:UsageLedger;
  readonly internalCompanyId:string;
  constructor(ledger:UsageLedger,internalCompanyId:string) { id(internalCompanyId);this.ledger=ledger;this.internalCompanyId=internalCompanyId; }
  private outside(companyId:string) { id(companyId); requireThat(companyId!==this.internalCompanyId,'internal_usage_not_billable',403); }
  private latest(companyId:string,period:string):{terms:CommercialTerms;digest:string}|undefined {
    const row=this.ledger.db.get<{body:string;digest:string}>('SELECT body,digest FROM commercial_terms WHERE tenant=? AND period=? ORDER BY seq DESC LIMIT 1',companyId,period);
    return row?{terms:JSON.parse(row.body) as CommercialTerms,digest:row.digest}:undefined;
  }
  /** The office's service must be active for new terms or a new checkout. Its
   * ledger caps are legacy and never checked: AI caps are Modelvia's. */
  private serving(companyId:string) {
    const tenant=this.ledger.tenant(companyId);
    requireThat(tenant.billingMode!=='internal_cost','internal_usage_not_billable',403);
    requireThat(tenant.active,'commercial_tenant_inactive',409);
    return tenant;
  }
  current(actor:PortalPrincipal,period:string) {
    requireThat(month(period),'invalid_billing_period');
    this.outside(actor.companyId);
    const latest=this.latest(actor.companyId,period);requireThat(latest,'commercial_terms_missing',404);
    const acceptance=this.ledger.db.get<{body:string}>('SELECT body FROM commercial_acceptances WHERE tenant=? AND period=? AND version=?',actor.companyId,period,latest.terms.version);
    return {...latest,acceptance:acceptance?JSON.parse(acceptance.body) as CommercialAcceptance:null};
  }
  /** Trusted operator publication. No HTTP route: the authenticated customer
   * must separately accept the exact published digest. */
  publish(draft:CommercialTermsDraft) {
    object(draft);exact(draft as unknown as Record<string,unknown>,['companyId','period','version','customer','seller','tax','sellerVerificationRef','customerTermsRef','careCents','careAgreementRef','rateCards',...(draft.aiUsage===undefined?[]:['aiUsage'])]);
    object(draft.customer);exact(draft.customer as Record<string,unknown>,['name','address',...(draft.customer.abn===undefined?[]:['abn']),...(draft.customer.tradingName===undefined?[]:['tradingName'])]);
    object(draft.seller);exact(draft.seller as unknown as Record<string,unknown>,['legalName','product','abn','address','gstRegistered']);
    object(draft.tax);exact(draft.tax as unknown as Record<string,unknown>,['currency','gstInclusive','gstBasisPoints','treatmentRef']);
    this.outside(draft.companyId);id(draft.version);
    requireThat(month(draft.period),'invalid_billing_period');
    const tenant=this.serving(draft.companyId);
    requireThat(draft.customer.name===tenant.customerName && draft.customer.address===tenant.customerAddress && draft.customer.abn===tenant.customerAbn,'commercial_customer_mismatch',409);
    requireThat(draft.customer.tradingName===undefined || (meaningful(draft.customer.tradingName,200) && !/[\u0000-\u001f\u007f]/.test(draft.customer.tradingName)),'commercial_customer_invalid',409);
    requireThat(meaningful(draft.seller.legalName,200) && meaningful(draft.seller.address) && draft.seller.product==='RealBud' && /^\d{11}$/.test(draft.seller.abn) && draft.seller.gstRegistered===true,'seller_basis_invalid',409);
    requireThat(draft.tax.currency==='AUD' && draft.tax.gstInclusive===true && draft.tax.gstBasisPoints===1000 && meaningful(draft.tax.treatmentRef,160),'tax_basis_invalid',409);
    [draft.sellerVerificationRef,draft.customerTermsRef].forEach(value=>{id(value);});
    requireThat(/^(0|[1-9]\d{0,12})$/.test(draft.careCents) && (draft.careCents==='0'?draft.careAgreementRef===null:typeof draft.careAgreementRef==='string'),'care_terms_invalid',409);
    if(draft.careAgreementRef!==null) id(draft.careAgreementRef);
    // AI pricing is Modelvia's. An empty list is the normal case; any entry is a
    // reference checked for shape only, never against a gateway rate card.
    requireThat(Array.isArray(draft.rateCards) && draft.rateCards.length<=100,'commercial_rate_cards_invalid',409);
    const versions=new Set<string>();
    for(const entry of draft.rateCards) {
      object(entry);exact(entry as Record<string,unknown>,['version','digest']);
      id(entry.version);requireThat(!versions.has(entry.version) && hex(entry.digest),'commercial_rate_card_invalid',409);versions.add(entry.version);
    }
    if(draft.aiUsage!==undefined) {
      validAiUsage(draft.aiUsage);
      // An operator's pending proposal for this office is what its next terms
      // must offer; a reviewed file stating another markup is refused, never merged.
      const proposed=proposedOfficeMarkup(this.ledger,draft.companyId);
      requireThat(proposed===undefined || proposed.markupBasisPoints===draft.aiUsage.markupBasisPoints,'ai_markup_differs_from_proposal',409);
    }
    const terms:CommercialTerms={...draft,publishedAt:this.ledger.now()};const termsDigest=digest(terms);
    this.ledger.db.transaction(()=>{
      requireThat(!this.ledger.db.get('SELECT id FROM invoices WHERE tenant=? AND period=?',draft.companyId,draft.period),'commercial_period_already_closed',409);
      requireThat(!this.ledger.db.get('SELECT seq FROM commercial_terms WHERE tenant=? AND period=? AND version=?',draft.companyId,draft.period,draft.version),'commercial_terms_version_exists',409);
      this.ledger.db.run('INSERT INTO commercial_terms(tenant,period,version,digest,body) VALUES(?,?,?,?,?)',draft.companyId,draft.period,draft.version,termsDigest,canonical(terms));
      this.ledger.db.append(draft.companyId,'commercial_terms_published',null,this.ledger.now(),{period:draft.period,version:draft.version,digest:termsDigest,sellerBasisDigest:this.sellerBasisDigest(terms)});
    });
    return {terms,digest:termsDigest};
  }
  accept(actor:PortalPrincipal,period:string,version:string,expectedDigest:string):CommercialAcceptance {
    requireThat(actor.role==='billing_owner','forbidden',403);this.outside(actor.companyId);id(version);
    const current=this.current(actor,period);
    requireThat(current.terms.version===version && current.digest===expectedDigest,'commercial_terms_changed',409);
    return this.ledger.db.transaction(()=>{
      const prior=this.ledger.db.get<{body:string}>('SELECT body FROM commercial_acceptances WHERE tenant=? AND period=? AND version=?',actor.companyId,period,version);
      if(prior)return JSON.parse(prior.body) as CommercialAcceptance;
      const acceptance:CommercialAcceptance={companyId:actor.companyId,period,version,digest:expectedDigest,subject:actor.subject,acceptedAt:this.ledger.now()};
      this.ledger.db.run('INSERT INTO commercial_acceptances(tenant,period,version,digest,body) VALUES(?,?,?,?,?)',actor.companyId,period,version,expectedDigest,canonical(acceptance));
      this.ledger.db.append(actor.companyId,'commercial_terms_accepted',null,this.ledger.now(),acceptance);
      // The office's own AI resale acceptance, recorded once with the reference
      // its Modelvia resale policy carries (office-ai-access.ts).
      const ai=current.terms.aiUsage;
      if(ai) this.ledger.db.append(actor.companyId,'ai_resale_terms_accepted',null,this.ledger.now(),
        {period,version,markupBasisPoints:ai.markupBasisPoints,termsReference:ai.termsReference,acceptanceReference:resaleAcceptanceReference(ai.termsReference,acceptance)} satisfies ResaleAcceptance);
      return acceptance;
    });
  }
  /** The latest terms for the month, accepted by the office's billing owner.
   * With `admission` the office must also be serving now (a new close or
   * checkout); without it an already issued checkout still reconciles. */
  accepted(companyId:string,period:string,version?:string,admission=true) {
    if(admission)this.outside(companyId);
    const current=this.latest(companyId,period);requireThat(current,'commercial_terms_missing',409);
    requireThat(!version || current.terms.version===version,'commercial_terms_stale',409);
    requireThat(current.digest===digest(current.terms),'commercial_terms_corrupt',503);
    const row=this.ledger.db.get<{body:string;digest:string}>('SELECT body,digest FROM commercial_acceptances WHERE tenant=? AND period=? AND version=?',companyId,period,current.terms.version);
    requireThat(row && row.digest===current.digest,'commercial_terms_not_accepted',409);
    const acceptance=JSON.parse(row.body) as CommercialAcceptance;
    requireThat(acceptance.companyId===companyId && acceptance.period===period && acceptance.version===current.terms.version && acceptance.digest===current.digest && acceptance.acceptedAt>=current.terms.publishedAt,'commercial_acceptance_mismatch',409);
    if(admission) {
      const tenant=this.serving(companyId);
      requireThat(current.terms.customer.name===tenant.customerName && current.terms.customer.address===tenant.customerAddress && current.terms.customer.abn===tenant.customerAbn,'commercial_customer_mismatch',409);
    }
    return {terms:current.terms,digest:current.digest,acceptance};
  }
  sellerBasisDigest(terms:CommercialTerms):string {return digest({seller:terms.seller,tax:terms.tax,sellerVerificationRef:terms.sellerVerificationRef});}
  bindInvoice(invoice:Invoice) {
    const reference=invoice.commercialTerms;requireThat(reference,'commercial_invoice_binding_missing',409);
    const accepted=this.accepted(invoice.companyId,invoice.period,reference.version);
    requireThat(reference.digest===accepted.digest && reference.acceptanceDigest===digest(accepted.acceptance) && reference.sellerBasisDigest===this.sellerBasisDigest(accepted.terms),'commercial_invoice_binding_mismatch',409);
    const binding:CollectionInvoiceBinding={invoiceId:invoice.id,companyId:invoice.companyId,period:invoice.period,invoiceDigest:digest(invoice),termsVersion:reference.version,termsDigest:accepted.digest,acceptanceDigest:reference.acceptanceDigest,sellerBasisDigest:reference.sellerBasisDigest,amountCents:invoice.totalCents};
    this.ledger.db.run('INSERT INTO collection_invoice_bindings(invoice,tenant,period,invoice_digest,terms_digest,amount_cents,body) VALUES(?,?,?,?,?,?,?)',invoice.id,invoice.companyId,invoice.period,binding.invoiceDigest,binding.termsDigest,binding.amountCents,canonical(binding));
    return binding;
  }
  assertCollectible(invoice:Invoice,expectedSellerBasisDigest?:string,admission=true):CollectionInvoiceBinding {
    if(admission)this.outside(invoice.companyId);
    requireThat(invoice.kind==='Tax Invoice' && BigInt(invoice.totalCents)>0n && invoice.commercialTerms,'commercial_invoice_not_collectible',409);
    const reference=invoice.commercialTerms;
    const accepted=this.accepted(invoice.companyId,invoice.period,reference.version,admission);
    requireThat(accepted.digest===reference.digest && digest(accepted.acceptance)===reference.acceptanceDigest && this.sellerBasisDigest(accepted.terms)===reference.sellerBasisDigest,'commercial_invoice_binding_mismatch',409);
    requireThat(invoice.supplier.legalName===accepted.terms.seller.legalName && invoice.supplier.abn===accepted.terms.seller.abn && invoice.supplier.address===accepted.terms.seller.address && canonical(invoice.customer)===canonical(accepted.terms.customer) && invoice.careAgreementRef===accepted.terms.careAgreementRef,'commercial_invoice_binding_mismatch',409);
    if(admission && expectedSellerBasisDigest)requireThat(hex(expectedSellerBasisDigest) && reference.sellerBasisDigest===expectedSellerBasisDigest,'seller_basis_not_approved',403);
    const row=this.ledger.db.get<{body:string}>('SELECT body FROM collection_invoice_bindings WHERE invoice=? AND tenant=?',invoice.id,invoice.companyId);
    requireThat(row,'commercial_invoice_binding_missing',409);
    const binding=JSON.parse(row.body) as CollectionInvoiceBinding;
    requireThat(binding.invoiceDigest===digest(invoice) && binding.companyId===invoice.companyId && binding.period===invoice.period && binding.invoiceId===invoice.id && binding.termsDigest===accepted.digest && binding.termsVersion===reference.version && binding.acceptanceDigest===reference.acceptanceDigest && binding.sellerBasisDigest===reference.sellerBasisDigest && binding.amountCents===invoice.totalCents,'commercial_invoice_binding_mismatch',409);
    return binding;
  }
}

/** One office's recorded acceptance of AI resale (the `ai_resale_terms_accepted`
 * ledger event). `acceptanceReference` is what its Modelvia resale policy carries. */
export interface ResaleAcceptance { period:string; version:string; markupBasisPoints:number; termsReference:string; acceptanceReference:string }
function validAiUsage(value:unknown):asserts value is AiUsageTerms {
  object(value);exact(value,['billing','markupBasisPoints','termsReference']);
  requireThat(value.billing==='resale' && Number.isSafeInteger(value.markupBasisPoints) && (value.markupBasisPoints as number)>=0 && (value.markupBasisPoints as number)<=MAX_OFFICE_MARKUP_BASIS_POINTS,'ai_usage_terms_invalid',409);
  id(value.termsReference);
}
/** The per-office acceptance reference: RealBud's resale terms reference plus
 * the digest of this office's acceptance, which names exactly one acceptance
 * row (and one `commercialTerms.acceptanceDigest` on its invoices). At most 193
 * printable characters, inside Modelvia's 200. */
export function resaleAcceptanceReference(termsReference:string,acceptance:CommercialAcceptance):string {
  id(termsReference);
  return `${termsReference}@${digest(acceptance).slice(0,32)}`;
}
/** The office's most recent acceptance of AI resale, whatever its markup: the
 * markup its Modelvia resale policy must carry. Undefined when never accepted. */
export function latestResaleAcceptance(ledger:UsageLedger,companyId:string):ResaleAcceptance|undefined {
  const row=ledger.db.get<{body:string}>("SELECT body FROM events WHERE tenant=? AND kind='ai_resale_terms_accepted' ORDER BY seq DESC LIMIT 1",companyId);
  return row?JSON.parse(row.body) as ResaleAcceptance:undefined;
}
/** An operator's proposed markup for one office (`ai_markup_proposed` event),
 * while it is still PENDING: not yet accepted by the office. Undefined when there
 * is none or the office has since accepted terms at that markup. */
export interface MarkupProposal { markupBasisPoints:number; subject:string; proposedAt:number; reason:string }
export function proposedOfficeMarkup(ledger:UsageLedger,companyId:string):MarkupProposal|undefined {
  const row=ledger.db.get<{seq:number;body:string}>("SELECT seq,body FROM events WHERE tenant=? AND kind='ai_markup_proposed' ORDER BY seq DESC LIMIT 1",companyId);
  if(!row) return undefined;
  const proposal=JSON.parse(row.body) as MarkupProposal;
  const acceptedSince=ledger.db.all<{body:string}>("SELECT body FROM events WHERE tenant=? AND kind='ai_resale_terms_accepted' AND seq>? ORDER BY seq",companyId,row.seq)
    .some(r=>(JSON.parse(r.body) as ResaleAcceptance).markupBasisPoints===proposal.markupBasisPoints);
  return acceptedSince?undefined:proposal;
}
