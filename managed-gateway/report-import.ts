/** Report billing seams for the existing website. Synthetic schema ONLY: the real DeepSeek
 * export schema, cost columns and report timezone are not yet verified. No dashboard/API access. */
import { canonical, exact, id, integer, nano, object, requireThat, type Units, type PortalPrincipal } from './contracts.ts';
import { digest, UsageLedger } from './ledger.ts';
import { modelRate,periodAt,price,retailProposal,validateUnits } from './money.ts';
interface KeyMapping {id:string;provider:'deepseek';keyReference:string;companyId:string;startsAt:number;endsAt:number;evidence:string}
export interface ReportPolicy {
  version:string;companyId:string;acceptedPricingRef:string;model:string;
  pricing:{kind:'accepted_unit_rates';rateVersion:string}|{kind:'verified_cost';currency:'AUD'|'USD';fxNumerator:string;fxDenominator:string;fxSource:string;method:'markup'|'margin';basisPoints:number};
}
interface ReportRow {keyReference:string;model:string;startsAt:number;endsAt:number;units:Units;cost?:{amountNanoCurrency:string;currency:'AUD'|'USD';basis:'before_gst'}}
interface SyntheticReport {schema:'realbud-synthetic-report-v1';provider:'deepseek';sourceReference:string;rows:ReportRow[]}
interface PreviewLine {id:string;companyId:string;period:string;policyVersion:string;model:string;rateVersion:string;units:Units;retailNanoAud:string;chargedNanoAud:string;included:boolean;row:ReportRow;status:'ready'|'overlap'|'meter_reconciliation_required'|'period_closed'}
export interface ReportPreview {synthetic:true;reportDigest:string;lines:PreviewLine[];alreadyImported:boolean;previewDigest:string}
const MAX_TIME=Number.MAX_SAFE_INTEGER;
function keyRef(value:unknown) {requireThat(typeof value==='string' && /^key-ref-[A-Za-z0-9_.-]{1,80}$/.test(value),'nonsecret_key_reference_required');}
function parseSynthetic(raw:string):SyntheticReport {
  requireThat(Buffer.byteLength(raw)<=1_000_000,'report_too_large',413);let parsed:unknown;try{parsed=JSON.parse(raw);}catch{requireThat(false,'invalid_report');}
  object(parsed);exact(parsed,['schema','provider','sourceReference','rows']);requireThat(parsed.schema==='realbud-synthetic-report-v1' && parsed.provider==='deepseek','unverified_report_schema');id(parsed.sourceReference);
  requireThat(Array.isArray(parsed.rows) && parsed.rows.length>0 && parsed.rows.length<=1000,'invalid_report_rows');
  for(const row of parsed.rows){object(row);exact(row,['keyReference','model','startsAt','endsAt','units',...(Object.hasOwn(row,'cost')?['cost']:[])]);keyRef(row.keyReference);id(row.model);integer(row.startsAt,MAX_TIME);integer(row.endsAt,MAX_TIME);requireThat(row.startsAt<row.endsAt && periodAt(row.startsAt)===periodAt(row.endsAt-1),'row_crosses_period');object(row.units);validateUnits(row.units);
    if(row.cost!==undefined){object(row.cost);exact(row.cost,['amountNanoCurrency','currency','basis']);nano(row.cost.amountNanoCurrency);requireThat(['USD','AUD'].includes(String(row.cost.currency)) && row.cost.basis==='before_gst','unsupported_source_cost');}
  }
  return parsed as unknown as SyntheticReport;
}
export class ReportImports {
  readonly ledger:UsageLedger;
  constructor(ledger:UsageLedger){this.ledger=ledger;}
  /** Operator-only. Persisted rotation windows are half-open and cannot overlap for one key ID. */
  mapKey(mapping:KeyMapping) {
    id(mapping.id);keyRef(mapping.keyReference);id(mapping.companyId);id(mapping.evidence);requireThat(mapping.provider==='deepseek','unsupported_report_provider');integer(mapping.startsAt,MAX_TIME);integer(mapping.endsAt,MAX_TIME);requireThat(mapping.startsAt<mapping.endsAt,'invalid_mapping_window');this.ledger.tenant(mapping.companyId);
    this.ledger.db.transaction(()=>{
      const prior=this.ledger.db.get<{body:string}>('SELECT body FROM report_key_mappings WHERE id=?',mapping.id);if(prior){requireThat(prior.body===canonical(mapping),'key_mapping_conflict',409);return;}
      requireThat(!this.ledger.db.get('SELECT id FROM report_key_mappings WHERE provider=? AND key_ref=? AND starts<? AND ends>?',mapping.provider,mapping.keyReference,mapping.endsAt,mapping.startsAt),'key_mapping_overlap',409);
      this.ledger.db.run('INSERT INTO report_key_mappings(id,provider,key_ref,starts,ends,body) VALUES(?,?,?,?,?,?)',mapping.id,mapping.provider,mapping.keyReference,mapping.startsAt,mapping.endsAt,canonical(mapping));this.ledger.db.append(mapping.companyId,'report_key_mapped',null,this.ledger.now(),mapping);
    });
  }
  /** Private pricing inputs. Supplying an evidence reference does not create customer acceptance. */
  recordPolicy(policy:ReportPolicy) {
    [policy.version,policy.companyId,policy.acceptedPricingRef,policy.model].forEach(id);this.ledger.tenant(policy.companyId);
    if(policy.pricing.kind==='verified_cost'){requireThat(['AUD','USD'].includes(policy.pricing.currency),'unsupported_source_currency');id(policy.pricing.fxSource);retailProposal({costNano:'0',...policy.pricing});if(policy.pricing.currency==='AUD')requireThat(policy.pricing.fxNumerator===policy.pricing.fxDenominator,'aud_fx_must_be_one');}
    else {requireThat(policy.pricing.kind==='accepted_unit_rates','invalid_import_pricing');modelRate(this.ledger.card(policy.pricing.rateVersion),policy.model);requireThat(this.ledger.db.get('SELECT body FROM acceptances WHERE tenant=? AND version=?',policy.companyId,policy.pricing.rateVersion),'rates_not_accepted',409);}
    this.ledger.db.transaction(()=>{const prior=this.ledger.db.get<{body:string}>('SELECT body FROM report_policies WHERE id=?',policy.version);if(prior){requireThat(prior.body===canonical(policy),'report_policy_conflict',409);return;}this.ledger.db.run('INSERT INTO report_policies(id,body) VALUES(?,?)',policy.version,canonical(policy));this.ledger.db.append(policy.companyId,'private_report_policy_recorded',null,this.ledger.now(),policy);});
  }
  /** Trusted operator preview only; rows contain private source amounts. Never return it as portal JSON. */
  preview(raw:string,policies:Record<string,string>):ReportPreview {
    const report=parseSynthetic(raw),reportDigest=digest(report),alreadyImported=!!this.ledger.db.get('SELECT digest FROM report_imports WHERE digest=?',reportDigest);const lines:PreviewLine[]=[];
    for(const row of report.rows) {
      requireThat(row.endsAt<=this.ledger.now(),'future_report');
      const mapped=this.ledger.db.get<{body:string}>('SELECT body FROM report_key_mappings WHERE provider=? AND key_ref=? AND starts<=? AND ends>=?',report.provider,row.keyReference,row.startsAt,row.endsAt);requireThat(mapped,'key_mapping_required',409);const mapping:KeyMapping=JSON.parse(mapped.body),tenant=this.ledger.tenant(mapping.companyId),period=periodAt(row.startsAt);
      requireThat(row.startsAt>=tenant.goLiveAt && !(row.startsAt<tenant.includedUntil && row.endsAt>tenant.includedUntil),'row_crosses_service_boundary');
      const selected=policies[`${mapping.companyId}/${row.model}`];requireThat(selected,'report_policy_required',409);const saved=this.ledger.db.get<{body:string}>('SELECT body FROM report_policies WHERE id=?',selected);requireThat(saved,'report_policy_required',409);const policy:ReportPolicy=JSON.parse(saved.body);requireThat(policy.companyId===mapping.companyId && policy.model===row.model,'report_policy_scope_mismatch',409);
      let retail:string,rateVersion:string;
      if(policy.pricing.kind==='verified_cost'){requireThat(row.cost && row.cost.currency===policy.pricing.currency,'verified_cost_required',409);retail=retailProposal({costNano:row.cost.amountNanoCurrency,...policy.pricing});rateVersion=`report-${policy.version}`;}
      else {requireThat(Object.keys(row.units).length>0,'usage_units_required');retail=price(modelRate(this.ledger.card(policy.pricing.rateVersion),row.model),row.units).toString();rateVersion=policy.pricing.rateVersion;}
      let status:PreviewLine['status']='ready';
      const existing=this.ledger.db.get<{import_digest:string}>('SELECT import_digest FROM report_rows WHERE provider=? AND key_ref=? AND model=? AND starts<? AND ends>?',report.provider,row.keyReference,row.model,row.endsAt,row.startsAt);
      if((existing && existing.import_digest!==reportDigest) || lines.some(l=>l.row.keyReference===row.keyReference && l.model===row.model && l.row.startsAt<row.endsAt && l.row.endsAt>row.startsAt))status='overlap';
      if(this.ledger.requests(mapping.companyId).some(r=>r.period===period))status='meter_reconciliation_required';
      if(this.ledger.db.get('SELECT id FROM statements WHERE tenant=? AND period>=? UNION ALL SELECT id FROM invoices WHERE tenant=? AND period>=?',mapping.companyId,period,mapping.companyId,period))status='period_closed';
      lines.push({id:digest({provider:report.provider,row}),companyId:mapping.companyId,period,policyVersion:policy.version,model:row.model,rateVersion,units:row.units,retailNanoAud:retail,chargedNanoAud:row.startsAt<tenant.includedUntil?'0':retail,included:row.startsAt<tenant.includedUntil,row,status});
    }
    const preview={synthetic:true as const,reportDigest,lines,alreadyImported};return {...preview,previewDigest:digest(preview)};
  }
  /** Review/commit checks run again atomically. No billed records can drift after preview. */
  commit(raw:string,policies:Record<string,string>,expectedPreviewDigest:string) {
    return this.ledger.db.transaction(()=>{
      const preview=this.preview(raw,policies);requireThat(preview.previewDigest===expectedPreviewDigest,'report_preview_changed',409);
      if(preview.alreadyImported)return {reportDigest:preview.reportDigest,duplicate:true};
      requireThat(preview.lines.every(l=>l.status==='ready'),'report_review_required',409);
      const report=parseSynthetic(raw);this.ledger.db.run('INSERT INTO report_imports(digest,body) VALUES(?,?)',preview.reportDigest,canonical({schema:report.schema,sourceReference:report.sourceReference,provider:report.provider,rows:preview.lines.length,importedAt:this.ledger.now()}));
      for(const line of preview.lines) {
        const source=this.ledger.db.get<{mode:string}>('SELECT mode FROM billing_sources WHERE tenant=? AND period=?',line.companyId,line.period);requireThat(!source || source.mode==='report','billing_source_conflict',409);if(!source)this.ledger.db.run("INSERT INTO billing_sources(tenant,period,mode) VALUES(?,?,'report')",line.companyId,line.period);
        this.ledger.db.run('INSERT INTO report_rows(id,import_digest,provider,key_ref,model,starts,ends,tenant,body) VALUES(?,?,?,?,?,?,?,?,?)',line.id,preview.reportDigest,report.provider,line.row.keyReference,line.model,line.row.startsAt,line.row.endsAt,line.companyId,canonical(line));
        const {period,model,rateVersion,units,retailNanoAud,chargedNanoAud,included}=line;this.ledger.db.append(line.companyId,'report_usage_accepted',null,this.ledger.now(),{period,model,rateVersion,units,retailNanoAud,chargedNanoAud,included,reportRowId:line.id,synthetic:true});
      }
      return {reportDigest:preview.reportDigest,duplicate:false};
    });
  }
  /** Customer preview strips key refs, supplier cost, FX and margin; statement acceptance is separate. */
  customerPreview(actor:PortalPrincipal,preview:ReportPreview) {
    return {synthetic:true,currency:'AUD',gstInclusive:true,lines:preview.lines.filter(l=>l.companyId===actor.companyId).map(({period,model,units,chargedNanoAud,included})=>({period,model,units,chargedNanoAud,included}))};
  }
}
