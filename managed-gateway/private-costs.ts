import { canonical, id, integer, nano, requireThat, type Units } from './contracts.ts';
import { UsageLedger, digest } from './ledger.ts';
import { retailProposal, validateUnits } from './money.ts';

export interface PrivateCostRevision {
  id:string; providerId:string; model:string; sourceReference:string; verifiedAt:number;
  /** Foreign-currency nano units per denominator. FX converts that currency to AUD. */
  currency:string; units:Partial<Record<keyof Units,{nanoCurrency:string;perUnits:number}>>;
  fx:{numerator:string;denominator:string;sourceReference:string;fixedAt:number};
  policy:{method:'markup'|'margin';basisPoints:number};
}
/** Operator-only cost provenance and pricing policy. Never included in the portal catalogue,
 * grants, invoices, public docs or desktop environment. No production defaults. */
export class PrivateCosts {
  private readonly ledger:UsageLedger;
  constructor(ledger:UsageLedger) { this.ledger=ledger; }
  save(revision:PrivateCostRevision) {
    [revision.id,revision.providerId,revision.model,revision.sourceReference,revision.fx.sourceReference].forEach(id);
    requireThat(/^[A-Z]{3}$/.test(revision.currency),'invalid_currency'); integer(revision.verifiedAt,Number.MAX_SAFE_INTEGER); integer(revision.fx.fixedAt,Number.MAX_SAFE_INTEGER);
    requireThat(revision.verifiedAt<=this.ledger.now() && revision.fx.fixedAt<=this.ledger.now(),'future_cost_revision');
    requireThat(Object.keys(revision.units).length>0,'missing_cost_units'); validateUnits(Object.fromEntries(Object.keys(revision.units).map(u=>[u,0])));
    for(const rate of Object.values(revision.units)) { nano(rate.nanoCurrency); integer(rate.perUnits); requireThat(rate.perUnits>0,'invalid_cost_denominator');
      retailProposal({costNano:rate.nanoCurrency,fxNumerator:revision.fx.numerator,fxDenominator:revision.fx.denominator,...revision.policy}); }
    this.ledger.db.transaction(()=>{
      requireThat(!this.ledger.db.get('SELECT id FROM evidence WHERE id=?',`cost:${revision.id}`),'cost_revision_exists',409);
      this.ledger.db.run('INSERT INTO evidence(id,request,digest) VALUES(?,?,?)',`cost:${revision.id}`,'operator',digest(revision));
      this.ledger.db.append('operator','private_cost_revision',null,this.ledger.now(),revision);
    });
  }
  proposal(revisionId:string) {
    const row=this.ledger.db.all<{body:string}>("SELECT body FROM events WHERE tenant='operator' AND kind='private_cost_revision'").find(r=>JSON.parse(r.body).id===revisionId);
    requireThat(row,'cost_revision_not_found',404); const revision:PrivateCostRevision=JSON.parse(row.body);
    return {sourceCostRevision:revision.id,status:'unpublished_draft' as const,model:revision.model,units:Object.fromEntries(Object.entries(revision.units).map(([u,r])=>[u,{nanoAud:retailProposal({costNano:r!.nanoCurrency,fxNumerator:revision.fx.numerator,fxDenominator:revision.fx.denominator,...revision.policy}),perUnits:r!.perUnits}]))};
  }
  /** Actual provider cost evidence stays separate from retail usage. It must identify the
   * gateway dispatch AND the upstream request; mismatches are investigated, never guessed. */
  reconcileCost(input:{evidenceId:string;dispatchId:string;providerId:string;providerRequestId:string;currency:string;actualCostNano:string;sourceReference:string}) {
    [input.evidenceId,input.dispatchId,input.providerId,input.providerRequestId,input.sourceReference].forEach(id); nano(input.actualCostNano); requireThat(/^[A-Z]{3}$/.test(input.currency),'invalid_currency');
    this.ledger.db.transaction(()=>{
      const r=this.ledger.request(input.dispatchId); requireThat(r.providerId===input.providerId && r.state==='settled','unreconciled_provider_usage',409);
      const bound=this.ledger.db.get<{request:string}>('SELECT request FROM provider_requests WHERE id=?',`${r.providerNamespace}:${input.providerRequestId}`);
      requireThat(bound?.request===r.id,'provider_cost_binding_mismatch',409);
      const key=`provider-cost:${input.providerId}:${input.evidenceId}`,hash=digest(input),old=this.ledger.db.get<{digest:string}>('SELECT digest FROM evidence WHERE id=?',key);
      if(old) { requireThat(old.digest===hash,'provider_cost_conflict',409); return; }
      this.ledger.db.run('INSERT INTO evidence(id,request,digest) VALUES(?,?,?)',key,r.id,hash);
      this.ledger.db.append('operator','provider_cost_reconciled',r.id,this.ledger.now(),JSON.parse(canonical(input)));
    });
  }
}
