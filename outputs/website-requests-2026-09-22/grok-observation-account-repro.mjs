/** No network: actual client and gateway, in-memory ledger, fictional provider. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ManagedConnectors,newConnectorCredential } from '../../managed-gateway/connectors.ts';
import { fixture } from '../../managed-gateway/testing.ts';
import { managedConnectorAccess,scanManagedMail } from '../../server/managed-connectors.ts';
const f=fixture(),credential=newConnectorCredential();
let device={id:'connector-one',companyId:f.tenant.companyId,licenseId:f.tenant.licenseId,memberId:'member-a',installationId:'installation-a',profile:'property',tokenHash:credential.tokenHash,active:true,expiresAt:f.now()+3600000,projectKeyEnv:'REALBUD_COMPOSIO_PROJECT_A',authConfigId:'auth-a',userId:'user-a',accountId:'account-a'};
let scans=0,accountRead=null,requestFields=[];
const broker=new ManagedConnectors({ledger:f.ledger,devices:()=>[device],secret:()=> 'ak_fictional_provider',access:async b=>({checkedAt:new Date(f.now()).toISOString(),services:{gmail:{connected:true,status:'ACTIVE',accounts:[{id:b.accountId,status:'ACTIVE'}],accountSelectionRequired:false}},tools:{available:true,names:['GMAIL_GET_PROFILE']}}),scan:async (b,scope)=>{scans++;accountRead=b.accountId;return {accountId:b.accountId,windowStartAt:scope.windowStartAt,windowEndAt:scope.windowEndAt,threads:[],pages:1,paginationComplete:true,gaps:[]};}});
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{if(new URL(url).origin!=='https://fixture.invalid')throw new Error('External network forbidden');const body=init.body?JSON.parse(init.body):undefined;if(new URL(url).pathname.endsWith('mail-scan'))requestFields=Object.keys(body).sort();try{const reply=await broker.handle({token:credential.token,profile:'property',method:init.method,path:new URL(url).pathname,...(body?{body}:{}),signal:init.signal});return Response.json(reply.body,{status:reply.status});}catch(error){return Response.json({error:'Fictional gateway held request'},{status:error.status??500});}};
try{
 const cfg={composio:{managed:{endpoint:'https://fixture.invalid',credential:credential.token,profile:'property'}}};
 const status=await managedConnectorAccess(cfg),reviewed=status.services.gmail.accounts[0].id;
 device={...device,accountId:'account-b'};
 const scope={windowStartAt:f.now()-86400000,windowEndAt:f.now(),includeSent:false,maxMessages:10,carryThreadIds:[]};
 let clientResult='accepted';try{await scanManagedMail(cfg,reviewed,scope,new AbortController().signal);}catch{clientResult=scans?'rejected-after-read':'rejected-before-read';}
 const sourceSha256=Object.fromEntries(['server/managed-connectors.ts','managed-gateway/connectors.ts'].map(file=>[file,createHash('sha256').update(readFileSync(new URL('../../'+file,import.meta.url))).digest('hex')]));
 const result={verifiedAt:new Date().toISOString(),scope:'Actual desktop connector client and gateway in a no-network in-memory fixture; fictional provider only',reviewedAccount:reviewed,gatewayCurrentAccount:device.accountId,providerScanCalls:scans,providerAccountRead:accountRead,clientResult,requestFields,sourceSha256,passed:scans===0&&clientResult==='rejected-before-read'};
 console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}finally{globalThis.fetch=originalFetch;f.close();}
