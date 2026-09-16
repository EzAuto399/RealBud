// Offline regression adapted from the independent core reproduction; current candidate.
import assert from 'node:assert/strict';
import { fixture } from '../../testing.ts';
import type { ProviderAdapter, ModelRequest } from '../../contracts.ts';
const f=fixture();
try {
  const request:ModelRequest={...f.request,protocol:'tools-v1',tools:[],thinking:'enabled'};
  const grant=f.grant(request,{schema:2,grantVersion:2,modelCallId:'final-output-repro',maxAttemptSpendNanoAud:'1000000000',attemptExpiresAt:f.now()+60000,provider:f.provider.usageNamespace,allowedModels:[{provider:f.provider.usageNamespace,model:request.model,capabilities:['text']}]});
  const provider:ProviderAdapter={...f.provider,async *stream(){
    yield {type:'continuation',message:{role:'assistant',content:'PRIVATE_SYNTHETIC_CONTINUATION',reasoning_content:'SYNTHETIC_REASONING'}};
    yield {type:'usage',evidence:f.evidence()};
    f.ledger.revokeIssuer('fixture-host-key');
  }};
  const events:unknown[]=[];
  let rejected=false;
  try {await f.gateway(provider).execute(f.envelope(grant),request,async event=>{events.push(event);},new AbortController().signal);}catch{rejected=true;}
  const leaked=JSON.stringify(events).includes('PRIVATE_SYNTHETIC_CONTINUATION');
  const receipt={fixtureOnly:true,issuerRevoked:f.ledger.issuer('fixture-host-key')?.revoked,rejected,privateContinuationForwardedAfterRevocation:leaked,eventTypes:events.map((e:any)=>e.type),ledgerState:f.ledger.requests('company-a')[0].state};
  console.log(JSON.stringify(receipt,null,2));
  assert(receipt.issuerRevoked && !leaked && rejected && receipt.ledgerState==='settled','Final output must be denied while validated incurred usage stays settled.');
} finally {f.close();}
