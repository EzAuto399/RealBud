/** Synthetic fixtures only. Production composition must never import this module. */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { canonical, type ExecutionAuthority, type ExecutionGrant, type ModelRequest, type ProviderAdapter, type ProviderEvent, type RateCard, type Tenant, type UsageEvidence } from './contracts.ts';
import { LedgerDatabase } from './database.ts';
import { digest, UsageLedger } from './ledger.ts';
import { twoMonthsAfter } from './money.ts';
import { ManagedGateway } from './gateway.ts';
import type { CommercialTermsDraft } from './commercial-terms.ts';

export const FIXTURE_TIME=Date.parse('2026-09-15T00:00:00Z');
export function fixture(path=':memory:') {
  let clock=FIXTURE_TIME;
  const now=()=>clock, db=new LedgerDatabase(path), ledger=new UsageLedger(db,now);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const card:RateCard={version:'fixture-r1',currency:'AUD',gstInclusive:true,gstBasisPoints:1000,publishedAt:clock-1000,effectiveAt:clock-1000,models:[{model:'fixture-text',label:'Synthetic test model',units:{input_tokens:{nanoAud:'1000000',perUnits:1},output_tokens:{nanoAud:'2000000',perUnits:1},cache_read_tokens:{nanoAud:'250000',perUnits:1}}}]};
  const goLiveAt=Date.parse('2026-06-01T00:00:00Z');
  const tenant:Tenant={companyId:'company-a',licenseId:'license-a',active:true,serviceExpiresAt:clock+365*86400000,customerName:'Fictional Agency A',customerAddress:'1 Example Street, Brisbane QLD',goLiveAt,goLiveEvidence:'fixture-go-live',includedUntil:twoMonthsAfter(goLiveAt),monthlyCapNanoAud:'100000000000',requestCapNanoAud:'1000000000',maxConcurrent:4};
  ledger.provisionTenant(tenant); ledger.publishCard(card);
  const owner={subject:'portal-owner-a',companyId:tenant.companyId,role:'billing_owner' as const};
  ledger.acceptCard(owner,card.version,digest(card));
  ledger.enrollIssuer({kid:'fixture-host-key',companyId:tenant.companyId,hostInstallationId:'install-a',publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString(),revoked:false,expiresAt:tenant.serviceExpiresAt});
  const request:ModelRequest={model:'fixture-text',rateVersion:card.version,idempotencyKey:'idem-one',messages:[{role:'user',content:'FICTIONAL PRIVATE PROMPT — should not persist'}],maxOutputTokens:20};
  const grant=(req=request,override:Partial<ExecutionGrant>={}):ExecutionGrant=>({schema:1,aud:'realbud-managed-ai',grantVersion:1,companyId:tenant.companyId,memberId:'member-a',hostInstallationId:'install-a',deviceId:'device-a',licenseId:tenant.licenseId,jobId:'job-one',attemptId:'attempt-one',revision:'1',authorityVersion:'1',operation:'model.stream',model:req.model,account:'managed-ai',resource:'job-one',jti:'grant-one',iat:clock,exp:clock+60000,rateVersion:req.rateVersion,maxSpendNanoAud:'1000000000',requestDigest:digest(req),...override});
  const envelope=(g=grant())=>{ const payload=canonical(g); return {kid:'fixture-host-key',payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64url')}; };
  const evidence=(override:Partial<UsageEvidence>={}):UsageEvidence=>({evidenceId:'usage-one',providerRequestId:'provider-one',units:{input_tokens:10,cache_read_tokens:5,output_tokens:4},outcome:'succeeded',source:'final_usage',...override});
  let calls=0; const revocation=new AbortController();
  const authority:ExecutionAuthority={async acquire(){return {signal:revocation.signal,async assertCurrent(){revocation.signal.throwIfAborted();},async release(){}};}};
  const provider:ProviderAdapter={id:'synthetic-provider',usageNamespace:'synthetic-provider',terms:{reviewReference:'fixture-no-provider-call',approvedUntil:tenant.serviceExpiresAt},bound(){return {input_tokens:100,cache_read_tokens:100,output_tokens:20};},async *stream(){calls++;yield {type:'delta',text:'Synthetic reply'};yield {type:'usage',evidence:evidence()};}};
  const gateway=(p=provider,a=authority)=>new ManagedGateway({ledger,routes:new Map([[request.model,p]]),authority:a,fingerprintKey:randomBytes(32)});
  const run=async(g=gateway(),req=request,claims=grant(req))=>{const output:unknown[]=[];await g.execute(envelope(claims),req,async event=>{output.push(event);},new AbortController().signal);return output;};
  return {db,ledger,card,tenant,owner,request,grant,envelope,evidence,provider,authority,revocation,gateway,now,setTime:(time:number)=>{clock=time;},calls:()=>calls,run,close:()=>db.close()};
}
export async function* events(...items:ProviderEvent[]) { yield* items; }
/** A reviewed monthly commercial terms draft for the fixture tenant. Every value
 * is fictional; `rateCards` stays empty because AI pricing is Modelvia's. */
export function careTermsDraft(f:{tenant:Tenant},version:string,careCents:string,override:Partial<CommercialTermsDraft>={}):CommercialTermsDraft {
  return {companyId:f.tenant.companyId,period:'2026-09',version,customer:{name:f.tenant.customerName,address:f.tenant.customerAddress,...(f.tenant.customerAbn?{abn:f.tenant.customerAbn}:{})},
    seller:{legalName:'Fictional RealBud Seller',product:'RealBud',abn:'12345678901',address:'1 Example Seller Street, Brisbane QLD',gstRegistered:true},
    tax:{currency:'AUD',gstInclusive:true,gstBasisPoints:1000,treatmentRef:'synthetic-tax-review'},sellerVerificationRef:'synthetic-seller-review',
    customerTermsRef:'synthetic-customer-contract',careCents,careAgreementRef:careCents==='0'?null:'synthetic-care-agreement',rateCards:[],...override};
}
