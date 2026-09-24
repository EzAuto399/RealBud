import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const moduleFile=process.argv[2] || 'outputs/two-device-gate-2026-09-22/before/scripts/check-two-device-acceptance.mjs';
const {checkEvidence, createTemplate,loadContract}=await import(pathToFileURL(path.resolve(moduleFile)));
const legacy={targets:{'macos-rehearsal':['macos-macos'],'full-platform':['macos-macos','macos-windows','windows-macos','windows-windows']},windows_only_cases:['OP-069'],both_members_cases:['OP-050'],caseIds:Array.from({length:71},(_,i)=>`OP-${String(i+1).padStart(3,'0')}`),workflow_runs:[['morning-a','OP-019','A'],['morning-b','OP-020','B'],['bills-a','OP-026','A'],['bills-b','OP-026','B'],['bank-a','OP-032','A'],['bank-b','OP-033','B']].map(([id,caseId,member])=>({id,caseId,member}))};
const contract=process.argv.includes('--live-contract')?loadContract():legacy;
const root=mkdtempSync(path.join(tmpdir(),'realbud-independent-gate-'));
const outside=mkdtempSync(path.join(tmpdir(),'realbud-independent-outside-'));
const digest=v=>createHash('sha256').update(v).digest('hex');
const safe='Synthetic file inside receipt only.\n', foreign='Synthetic outside file only.\n';
writeFileSync(path.join(root,'evidence.txt'),safe);writeFileSync(path.join(outside,'outside.txt'),foreign);
const fixture=()=>{
 const r=createTemplate(contract,'macos-rehearsal');Object.assign(r,{sourceManifestSha256:'a'.repeat(64),protocolVersion:'fixture-1',reviewerAlias:'fixture-reviewer',reviewedAt:'2026-09-15T03:00:00Z'});
 for(const p of r.pairings){p.companyAlias='fixture-company';for(const d of p.devices)Object.assign(d,{memberAlias:`member-${d.slot}`,deviceAlias:`device-${d.slot}`,providerUserAlias:`provider-${d.slot}`,osVersion:'macOS fixture',environment:'physical',artifactSha256:'b'.repeat(64),hermesVersion:'fixture',hermesCommit:'c'.repeat(40),cuaVersion:'fixture'});
 for(const run of p.workflowRuns)Object.assign(run,{status:'pass',proofLayer:'installed-device',jobId:run.id,attemptId:'attempt-1',companyAlias:p.companyAlias,workerContextAlias:`context-${run.member}`,executionDeviceAlias:`device-${run.member}`,providerUserAlias:`provider-${run.member}`,connectedAccountAlias:`account-${run.member}`,resultReceiptId:`result-${run.id}`,executionRoute:'company-managed-hermes',evidence:[{path:'evidence.txt',sha256:digest(safe)}]});
 for(const c of p.checks)Object.assign(c,{status:'pass',proofLayer:'installed-device',participants:['A','B'],evidence:[{path:'evidence.txt',sha256:digest(safe)}]});}return r;
};
const outcomes=[]; const run=(name,mutate,alt=contract)=>{let r=fixture();mutate(r);try{const result=checkEvidence(r,alt,{target:'macos-rehearsal',evidenceRoot:root});outcomes.push({name,threw:false,evidenceComplete:result.evidenceComplete,issues:result.issues.slice(0,4)});}catch(e){outcomes.push({name,threw:true,message:e.message});}};
try{
run('valid synthetic receipt',()=>{});
run('reused result receipt across separate jobs',r=>r.pairings[0].workflowRuns[1].resultReceiptId=r.pairings[0].workflowRuns[0].resultReceiptId);
run('numeric workflow id',r=>r.pairings[0].workflowRuns[0].id=7);
run('malformed Windows version object',r=>{r.pairings[0].devices[0].os='windows';r.pairings[0].devices[0].osVersion={toString:null};});
run('unknown and duplicate participant slots',r=>r.pairings[0].checks.find(c=>c.caseId==='OP-050').participants=['A','B','B','outside']);
run('empty participants on all non-designated cases',r=>r.pairings[0].checks.filter(c=>c.caseId!=='OP-050').forEach(c=>c.participants=[]));
run('shortened operational inventory contract',r=>r.pairings[0].checks=[] ,{...contract,caseIds:[],both_members_cases:[]});
for(const field of ['devices','workflowRuns','checks'])for(const value of [null,7,'x',{},[]])run(`malformed ${field} element ${JSON.stringify(value)}`,r=>r.pairings[0][field][0]=value);
const fuzzThrows=[];let mutationCount=0;
const scalarPaths=(v,p=[])=>v!==null&&typeof v==='object'?(Array.isArray(v)?(v.length?scalarPaths(v[0],[...p,0]):[]):Object.entries(v).flatMap(([k,x])=>scalarPaths(x,[...p,k]))):[p];
for(const keys of scalarPaths(fixture()))for(const value of [null,123,'',{},[],true,{toString:null},{toString:{}}]){const record=fixture();let dst=record;for(const key of keys.slice(0,-1))dst=dst[key];dst[keys.at(-1)]=value;mutationCount++;try{checkEvidence(record,contract,{target:'macos-rehearsal',evidenceRoot:root});}catch(e){fuzzThrows.push({path:keys.join('.'),value,message:e.message});}}
outcomes.push({name:'malformed scalar JSON mutation sweep',mutationCount,throws:fuzzThrows});
const originalStat=fs.statSync;let attacked=false;fs.statSync=function(file,...args){const result=originalStat(file,...args);if(!attacked&&typeof file==='string' && path.basename(file)==='evidence.txt'){attacked=true;rmSync(file);symlinkSync(path.join(outside,'outside.txt'),file);}return result;};syncBuiltinESMExports();
run('stat-to-read symlink substitution reads outside',r=>{for(const p of r.pairings)for(const v of [...p.workflowRuns,...p.checks])v.evidence[0].sha256=digest(foreign);});
fs.statSync=originalStat;syncBuiltinESMExports();outcomes.push({name:'path race hook fired',attacked});
}finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
console.log(JSON.stringify({moduleFile,syntheticOnly:true,outcomes},null,2));
