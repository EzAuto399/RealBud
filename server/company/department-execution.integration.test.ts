import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {createCompanyKernel} from './index.ts';
import {createCompanyPortalCertificateGate} from './portal-proof.ts';
import {startCompanyPostgresFixture} from './testing-postgres.ts';
import {createOfficeBackup,restoreOfficeBackup} from './backup.ts';
import * as C from '../../shared/company-execution.ts';
import {canonicalWebsiteCommand} from '../../shared/website-commands.ts';

const secret=()=>randomBytes(32).toString('hex');
describe.runIf(process.env.REALBUD_TEST_POSTGRES==='1')('scoped department execution on actual PostgreSQL',()=>{
 let fixture:Awaited<ReturnType<typeof startCompanyPostgresFixture>>,directory:string,kernel:ReturnType<typeof createCompanyKernel>;
 let cert='a'.repeat(64);const gate=createCompanyPortalCertificateGate();
 const bridge={certificateDigest:()=>cert,withCertificate:gate.run,verify:async()=>{throw Error('Mapping verifier must never be used for local execution');}};
 beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'rb-department-execution-'));fixture=await startCompanyPostgresFixture({outputDirectory:directory});kernel=createCompanyKernel(fixture.pool,{portalBridge:bridge});},60000);
 afterAll(async()=>{await fixture?.stop();if(fixture)expect(JSON.parse(await readFile(join(fixture.directory,'fixture.json'),'utf8')).stopped).toBe(true);if(directory)await rm(directory,{recursive:true,force:true});});
 async function office(){
  const owner=await kernel.createCompany({name:'Fictional local office',ownerName:'Owner'}),invite=await kernel.issueInvitation(owner.sessionToken,{displayName:'Case member'}),member=await kernel.redeemInvitation(invite.invitationToken);
  let department=await kernel.createDepartment(owner.sessionToken,{requestId:randomUUID(),name:'Accounts'});
  department=await kernel.setDepartmentAccess(owner.sessionToken,{departmentId:department.id,memberId:member.memberId,access:'write',expectedRevision:department.revision});
  const item=(await kernel.createDepartmentCase(owner.sessionToken,{departmentId:department.id,requestId:randomUUID(),title:'Prepare fictional case',description:'Only this case description is permitted.',assigneeMemberId:member.memberId})).item;
  return {owner,member,department,item};
 }
 function beginInput(o:Awaited<ReturnType<typeof office>>):C.BeginCompanyExecution{return {version:1,requestId:randomUUID(),grantSecret:secret(),departmentId:o.department.id,expectedDepartmentRevision:o.department.revision,caseId:o.item.id,expectedCaseFence:o.item.fence,recipe:{id:'case-preparation',revision:1,digest:'b'.repeat(64),instructionDigest:'c'.repeat(64)},executor:{workspaceId:randomUUID(),workerBinding:randomUUID()},durationMs:86400000};}
 async function active(){const o=await office(),input=beginInput(o),pending=await kernel.beginDepartmentExecution(o.member.sessionToken,input),confirmation:C.ConfirmCompanyExecution={version:1,requestId:randomUUID(),grantId:pending.id,expectedRevision:pending.revision,grantDigest:pending.digest};const grant=await kernel.confirmDepartmentExecution(o.owner.sessionToken,confirmation);return {...o,input,confirmation,grant};}
 const admitInput=(grant:C.CompanyExecutionGrant):C.AdmitCompanyExecution=>({version:1,grantId:grant.id,requestId:randomUUID(),executionId:randomUUID(),claimSecret:secret(),ttlMs:300000});
 const checkInput=(input:C.AdmitCompanyExecution,r:C.CompanyExecutionReceipt):C.CheckCompanyExecution=>({version:1,grantId:input.grantId,executionId:input.executionId,claimSecret:input.claimSecret,fence:r.fence});
 it('binds a full reviewed plan and instructions before owner confirmation and rejects mismatched digests without a grant',async()=>{
  const o=await office(),input=beginInput(o),hash=(value:unknown)=>createHash('sha256').update(canonicalWebsiteCommand(value)).digest('hex');
  const review:C.CompanyExecutionReview={plan:{title:'Prepare fictional department case',description:'Draft a summary from this assigned case only.',steps:['Analyse the supplied case.','Draft a summary for human review.'],evidence:'Fictional draft, no external action',capabilities:['analyse','draft'],allowedOrigins:[],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:null},instructions:'Complete fictional instructions — preserve the supplied case facts.'};
  input.recipe={...input.recipe,review,digest:hash(review.plan),instructionDigest:hash(review.instructions)};
  for(const field of ['digest','instructionDigest'] as const){
   const invalid={...input,recipe:{...input.recipe,[field]:'0'.repeat(64)}};
   expect(()=>kernel.beginDepartmentExecution(o.member.sessionToken,invalid)).toThrow('invalid_input');
   expect((await fixture.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.department_execution_grants WHERE id=$1',[input.requestId])).rows[0].n).toBe(0);
   expect((await fixture.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.audit_events WHERE id=$1',[input.requestId])).rows[0].n).toBe(0);
  }
  const pending=await kernel.beginDepartmentExecution(o.member.sessionToken,input);
  expect(pending.spec.recipe).toEqual(input.recipe);
  expect(pending.digest).toBe(hash(pending.spec));
  const confirmed=await kernel.confirmDepartmentExecution(o.owner.sessionToken,{version:1,requestId:randomUUID(),grantId:pending.id,expectedRevision:pending.revision,grantDigest:pending.digest});
  expect(confirmed).toMatchObject({phase:'active',current:true,spec:{recipe:input.recipe}});
  const admit=admitInput(confirmed),receipt=await kernel.admitDepartmentExecution(input.grantSecret,admit);
  expect(receipt).toMatchObject({grantId:input.requestId,executionId:admit.executionId,caseId:o.item.id});
  expect((await kernel.checkDepartmentExecution(input.grantSecret,checkInput(admit,receipt))).source).toEqual(pending.source);
  expect((await fixture.adminPool.query('SELECT spec FROM realbud_company.department_execution_grants WHERE id=$1',[input.requestId])).rows[0].spec.recipe).toEqual(input.recipe);
 });
 it('returns scoped pending, confirmed and revoked status with immutable historical source',async()=>{
  const o=await office(),input=beginInput(o),pending=await kernel.beginDepartmentExecution(o.member.sessionToken,input),target={version:1 as const,grantId:pending.id};
  expect(await kernel.statusDepartmentExecution(input.grantSecret,target)).toEqual(pending);
  const confirmed=await kernel.confirmDepartmentExecution(o.owner.sessionToken,{version:1,requestId:randomUUID(),grantId:pending.id,expectedRevision:pending.revision,grantDigest:pending.digest});
  await kernel.revokeSession(o.member.sessionToken);
  expect(await kernel.statusDepartmentExecution(input.grantSecret,target)).toEqual(confirmed);
  const revoked=await kernel.revokeDepartmentExecution(o.owner.sessionToken,{version:1,requestId:randomUUID(),grantId:pending.id,expectedRevision:confirmed.revision,note:'Owner stopped background work'});
  await fixture.adminPool.query('UPDATE realbud_company.cases SET description=$2 WHERE id=$1',[o.item.id,'NEW CASE TEXT MUST NOT LEAK']);
  const held=await kernel.statusDepartmentExecution(input.grantSecret,target);
  expect(held).toEqual(revoked);expect(held.current).toBe(false);expect(held.source).toEqual(pending.source);expect(JSON.stringify(held)).not.toContain('NEW CASE TEXT');
 });
 it('denies wrong scoped credentials, member sessions and malformed status input and observes certificate/member state',async()=>{
  const o=await active(),other=await active(),target={version:1 as const,grantId:o.grant.id};
  await expect(kernel.statusDepartmentExecution(secret(),target)).rejects.toMatchObject({code:'unauthenticated'});
  await expect(kernel.statusDepartmentExecution(other.input.grantSecret,target)).rejects.toMatchObject({code:'unauthenticated'});
  await expect(kernel.statusDepartmentExecution(o.member.sessionToken,target)).rejects.toMatchObject({code:'unauthenticated'});
  for(const invalid of [{...target,extra:true},{...target,version:2},{...target,grantId:''},null])expect(()=>kernel.statusDepartmentExecution(o.input.grantSecret,invalid as typeof target)).toThrow('invalid_input');
  await gate.run(async()=>{cert='e'.repeat(64);});try{expect(await kernel.statusDepartmentExecution(o.input.grantSecret,target)).toMatchObject({id:o.grant.id,current:false,spec:o.grant.spec,source:o.grant.source});}finally{await gate.run(async()=>{cert='a'.repeat(64);});}
  await fixture.adminPool.query('UPDATE realbud_company.members SET active=false WHERE company_id=$1 AND id=$2',[o.owner.companyId,o.member.memberId]);
  await expect(kernel.statusDepartmentExecution(o.input.grantSecret,target)).rejects.toMatchObject({code:'unauthenticated'});
 });
 it('filters department grants before pagination and retains the original unfiltered list input',async()=>{
  const o=await active(),second=await kernel.beginDepartmentExecution(o.member.sessionToken,{...o.input,requestId:randomUUID(),grantSecret:secret()});
  const page=await kernel.listDepartmentExecutions(o.owner.sessionToken,{offset:0,limit:1,departmentId:o.department.id});
  expect(page.grants).toHaveLength(1);expect(page.hasMore).toBe(true);expect(page.grants[0].spec.departmentId).toBe(o.department.id);
  expect((await kernel.listDepartmentExecutions(o.owner.sessionToken,{offset:1,limit:1,departmentId:o.department.id})).grants[0].id).toBe(second.id);
  expect((await kernel.listDepartmentExecutions(o.owner.sessionToken,{offset:0,limit:10})).grants).toHaveLength(2);
  expect((await kernel.listDepartmentExecutions(o.owner.sessionToken,{offset:0,limit:10,departmentId:randomUUID()})).grants).toEqual([]);
  expect(()=>kernel.listDepartmentExecutions(o.owner.sessionToken,{offset:0,limit:10,departmentId:undefined})).toThrow('invalid_input');
 });
 it('requires assigned member consent then current owner confirmation, exposing only the exact case',async()=>{
  const o=await office(),input=beginInput(o);
  await expect(kernel.beginDepartmentExecution(o.owner.sessionToken,input)).rejects.toMatchObject({code:'forbidden'});
  const p=await kernel.beginDepartmentExecution(o.member.sessionToken,input);expect(C.isCompanyExecutionGrant(p)).toBe(true);expect(p.phase).toBe('pending');
  const a=admitInput(p);await expect(kernel.admitDepartmentExecution(input.grantSecret,a)).rejects.toMatchObject({code:'stale_claim'});
  await expect(kernel.confirmDepartmentExecution(o.member.sessionToken,{version:1,requestId:randomUUID(),grantId:p.id,expectedRevision:p.revision,grantDigest:p.digest})).rejects.toMatchObject({code:'forbidden'});
  await kernel.replaceKnowledge(o.owner.sessionToken,{scopeId:o.department.id,key:'private-extra',expectedRevision:'0',content:'NEVER EXPOSE THIS KNOWLEDGE'});
  const g=await kernel.confirmDepartmentExecution(o.owner.sessionToken,{version:1,requestId:randomUUID(),grantId:p.id,expectedRevision:p.revision,grantDigest:p.digest});
  const receipt=await kernel.admitDepartmentExecution(input.grantSecret,a),checked=await kernel.checkDepartmentExecution(input.grantSecret,checkInput(a,receipt));
  expect(C.isCompanyExecutionCheck(checked)).toBe(true);expect(checked.source).toEqual({caseId:o.item.id,title:o.item.title,description:o.item.description});expect(JSON.stringify(checked)).not.toContain('NEVER EXPOSE');expect(g.spec.purpose).toBe('local-department-prepare-v1');
  for(const value of [g,checked]){expect(JSON.stringify(value)).not.toContain(input.grantSecret);expect(JSON.stringify(value)).not.toContain(a.claimSecret);}
 });
 it('keeps begin, confirmation and admission exact across lost replies and a new kernel',async()=>{
  const o=await active(),a=admitInput(o.grant),receipt=await kernel.admitDepartmentExecution(o.input.grantSecret,a),reopened=createCompanyKernel(fixture.pool,{portalBridge:bridge});
  expect((await reopened.beginDepartmentExecution(o.member.sessionToken,o.input)).id).toBe(o.grant.id);expect((await reopened.confirmDepartmentExecution(o.owner.sessionToken,o.confirmation)).phase).toBe('admitted');
  expect(await reopened.admitDepartmentExecution(o.input.grantSecret,a)).toEqual(receipt);
  await expect(reopened.beginDepartmentExecution(o.member.sessionToken,{...o.input,grantSecret:secret()})).rejects.toMatchObject({code:'conflict'});
  await expect(reopened.admitDepartmentExecution(o.input.grantSecret,{...a,claimSecret:secret()})).rejects.toMatchObject({code:'conflict'});
  await expect(reopened.admitDepartmentExecution(o.input.grantSecret,{...a,requestId:randomUUID()})).rejects.toMatchObject({code:'conflict'});
  expect((await fixture.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.department_execution_claims WHERE grant_id=$1',[o.grant.id])).rows[0].n).toBe(1);
 });
 it('serializes competing claims through independent pools and preserves one case fence',async()=>{
  const o=await active(),otherPool=new Pool({connectionString:fixture.applicationUrl}),other=createCompanyKernel(otherPool,{portalBridge:{...bridge,withCertificate:createCompanyPortalCertificateGate().run}});
  try{const a=admitInput(o.grant),b=admitInput(o.grant),results=await Promise.allSettled([kernel.admitDepartmentExecution(o.input.grantSecret,a),other.admitDepartmentExecution(o.input.grantSecret,b)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
   const row=(await fixture.adminPool.query('SELECT fence,status FROM realbud_company.cases WHERE id=$1',[o.item.id])).rows[0];expect(row).toEqual({fence:'1',status:'claimed'});
  }finally{await otherPool.end();}
 });
 it('admits only one of two separately confirmed grants for the same assigned case',async()=>{
  const o=await active(),secondInput={...o.input,requestId:randomUUID(),grantSecret:secret()},pending=await kernel.beginDepartmentExecution(o.member.sessionToken,secondInput),second=await kernel.confirmDepartmentExecution(o.owner.sessionToken,{version:1,requestId:randomUUID(),grantId:pending.id,expectedRevision:pending.revision,grantDigest:pending.digest});
  const pool=new Pool({connectionString:fixture.applicationUrl}),other=createCompanyKernel(pool,{portalBridge:{...bridge,withCertificate:createCompanyPortalCertificateGate().run}});
  try{const results=await Promise.allSettled([kernel.admitDepartmentExecution(o.input.grantSecret,admitInput(o.grant)),other.admitDepartmentExecution(secondInput.grantSecret,admitInput(second))]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await fixture.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.department_execution_claims WHERE case_id=$1',[o.item.id])).rows[0].n).toBe(1);}finally{await pool.end();}
 });
 it('clips initial and renewed leases to grant expiry and refuses expired admission replay',async()=>{
  const o=await office(),input={...beginInput(o),durationMs:20000},pending=await kernel.beginDepartmentExecution(o.member.sessionToken,input),grant=await kernel.confirmDepartmentExecution(o.owner.sessionToken,{version:1,requestId:randomUUID(),grantId:pending.id,expectedRevision:pending.revision,grantDigest:pending.digest}),a=admitInput(grant),r=await kernel.admitDepartmentExecution(input.grantSecret,a),check=checkInput(a,r);
  expect(r.leaseExpiresAt).toBe(grant.expiresAt);expect(r.dispatchBefore).toBe(grant.expiresAt);
  const renewal={...check,requestId:randomUUID(),ttlMs:300000};expect((await kernel.renewDepartmentExecution(input.grantSecret,renewal)).leaseExpiresAt).toBe(grant.expiresAt);
  const original=(await fixture.adminPool.query("SELECT pg_get_functiondef('pg_catalog.clock_timestamp()'::regprocedure) AS def")).rows[0].def;
  try{
   await fixture.adminPool.query(`CREATE OR REPLACE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE PARALLEL SAFE AS $$SELECT '${grant.expiresAt}'::timestamptz$$`);
   await expect(kernel.checkDepartmentExecution(input.grantSecret,check)).rejects.toMatchObject({code:'stale_claim'});
   await expect(kernel.renewDepartmentExecution(input.grantSecret,renewal)).rejects.toMatchObject({code:'stale_claim'});
   await expect(kernel.admitDepartmentExecution(input.grantSecret,a)).rejects.toMatchObject({code:'stale_claim'});
   await expect(kernel.settleDepartmentExecution(input.grantSecret,{...check,requestId:randomUUID(),runId:'expired-run',outcome:'interrupted',note:''})).rejects.toMatchObject({code:'stale_claim'});
  }finally{await fixture.adminPool.query(original);}
 });
 it('observes revocation committed before a waiting admission reaches its lifecycle guard',async()=>{
  const o=await active(),holder=await fixture.adminPool.connect();
  await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`company-lifecycle:${o.owner.companyId}`]);
  const pending=kernel.admitDepartmentExecution(o.input.grantSecret,admitInput(o.grant));pending.catch(()=>{});
  try{
   const deadline=Date.now()+5000;let waiting=false;
   while(Date.now()<deadline){if((await fixture.adminPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock_shared%'")).rows[0].n>0){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(true);await holder.query('UPDATE realbud_company.members SET active=false WHERE company_id=$1 AND id=$2',[o.owner.companyId,o.member.memberId]);await holder.query('COMMIT');
   await expect(pending).rejects.toMatchObject({code:'unauthenticated'});expect((await fixture.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.department_execution_claims WHERE grant_id=$1',[o.grant.id])).rows[0].n).toBe(0);
  }finally{await holder.query('ROLLBACK');holder.release();}
 });
 it('rejects another grant, company, executor request and generic session routes',async()=>{
  const a=await active(),b=await active(),input=admitInput(a.grant),receipt=await kernel.admitDepartmentExecution(a.input.grantSecret,input),check=checkInput(input,receipt);
  await expect(kernel.checkDepartmentExecution(b.input.grantSecret,check)).rejects.toMatchObject({code:'unauthenticated'});
  await expect(kernel.checkDepartmentExecution(a.input.grantSecret,{...check,executionId:randomUUID()})).rejects.toMatchObject({code:'stale_claim'});
  await expect(kernel.checkDepartmentExecution(a.input.grantSecret,{...check,claimSecret:secret()})).rejects.toMatchObject({code:'stale_claim'});
  await expect(kernel.authenticateSession(a.input.grantSecret)).rejects.toMatchObject({code:'unauthenticated'});
  await expect(kernel.renewClaim(a.member.sessionToken,{caseId:a.item.id,fence:receipt.fence,claimToken:input.claimSecret,ttlMs:1000})).rejects.toMatchObject({code:'unauthenticated'});
  await expect(kernel.confirmDepartmentExecution(b.owner.sessionToken,a.confirmation)).rejects.toMatchObject({code:'not_found'});
 });
 it('renews with immutable receipt IDs, grant clipping and the unchanged initial dispatch deadline',async()=>{
  const o=await active(),input={...admitInput(o.grant),ttlMs:30000},admission=await kernel.admitDepartmentExecution(o.input.grantSecret,input),check=checkInput(input,admission),renewal:C.RenewCompanyExecution={...check,requestId:randomUUID(),ttlMs:300000};
  const renewed=await kernel.renewDepartmentExecution(o.input.grantSecret,renewal);expect(C.isCompanyExecutionReceipt(renewed)).toBe(true);expect(renewed.receiptId).toBe(renewal.requestId);expect(renewed.dispatchBefore).toBe(admission.dispatchBefore);expect(Date.parse(renewed.leaseExpiresAt)).toBeGreaterThan(Date.parse(admission.leaseExpiresAt));
  expect(await kernel.renewDepartmentExecution(o.input.grantSecret,renewal)).toEqual(renewed);
  const newer=await kernel.renewDepartmentExecution(o.input.grantSecret,{...renewal,requestId:randomUUID()});expect(await kernel.renewDepartmentExecution(o.input.grantSecret,renewal)).toEqual(renewed);
  expect((await kernel.checkDepartmentExecution(o.input.grantSecret,check)).receipt).toEqual(newer);
  expect(await kernel.admitDepartmentExecution(o.input.grantSecret,input)).toEqual(admission);expect((await kernel.checkDepartmentExecution(o.input.grantSecret,check)).receipt).toEqual(newer);
  await expect(kernel.renewDepartmentExecution(o.input.grantSecret,{...renewal,ttlMs:1000})).rejects.toMatchObject({code:'conflict'});
  expect(()=>kernel.renewDepartmentExecution(o.input.grantSecret,{...renewal,requestId:randomUUID(),ttlMs:300001})).toThrow('invalid_input');
 });
 it('revocation holds the case and denies new reads, renewal and settlement',async()=>{
  const o=await active(),a=admitInput(o.grant),receipt=await kernel.admitDepartmentExecution(o.input.grantSecret,a),check=checkInput(a,receipt),latest=(await kernel.listDepartmentExecutions(o.member.sessionToken,{offset:0,limit:10})).grants[0];
  const request:C.RevokeCompanyExecution={version:1,grantId:o.grant.id,requestId:randomUUID(),expectedRevision:latest.revision,note:'Stop this delegated preparation'};
  const revoked=await kernel.revokeDepartmentExecution(o.member.sessionToken,request);expect(revoked.phase).toBe('revoked');expect(await kernel.revokeDepartmentExecution(o.member.sessionToken,request)).toEqual(revoked);
  await expect(kernel.checkDepartmentExecution(o.input.grantSecret,check)).rejects.toMatchObject({code:'stale_claim'});await expect(kernel.renewDepartmentExecution(o.input.grantSecret,{...check,requestId:randomUUID(),ttlMs:1000})).rejects.toMatchObject({code:'stale_claim'});
  await expect(kernel.settleDepartmentExecution(o.input.grantSecret,{...check,requestId:randomUUID(),runId:'run-1',outcome:'prepared',note:'Private output kept locally'})).rejects.toMatchObject({code:'stale_claim'});
  expect((await fixture.adminPool.query('SELECT status,fence FROM realbud_company.cases WHERE id=$1',[o.item.id])).rows[0]).toEqual({status:'recovery_required',fence:'2'});
 });
 it('permission and ownership ABA cannot restore consumed background authority',async()=>{
  for(const mutation of ['permission','ownership'] as const){const o=await active(),a=admitInput(o.grant),r=await kernel.admitDepartmentExecution(o.input.grantSecret,a);
   if(mutation==='permission'){const read=await kernel.setDepartmentAccess(o.owner.sessionToken,{departmentId:o.department.id,memberId:o.member.memberId,access:'read',expectedRevision:o.department.revision});await kernel.setDepartmentAccess(o.owner.sessionToken,{departmentId:o.department.id,memberId:o.member.memberId,access:'write',expectedRevision:read.revision});}
   else{const offer=await kernel.offerOwnership(o.owner.sessionToken,o.member.memberId);await kernel.acceptOwnership(o.member.sessionToken,offer.id);const back=await kernel.offerOwnership(o.member.sessionToken,o.owner.memberId);await kernel.acceptOwnership(o.owner.sessionToken,back.id);}
   await expect(kernel.checkDepartmentExecution(o.input.grantSecret,checkInput(a,r))).rejects.toMatchObject({code:'stale_claim'});expect((await fixture.adminPool.query('SELECT revoked_at FROM realbud_company.department_execution_grants WHERE id=$1',[o.grant.id])).rows[0].revoked_at).toBeInstanceOf(Date);
  }
 });
 it('prepared settlement is exact and leaves human recovery, never done or released',async()=>{
  const o=await active(),a=admitInput(o.grant),r=await kernel.admitDepartmentExecution(o.input.grantSecret,a),check=checkInput(a,r),request:C.SettleCompanyExecution={...check,requestId:randomUUID(),runId:'private-run-123',outcome:'prepared',note:'Prepared privately; person must review.'};
  const settled=await kernel.settleDepartmentExecution(o.input.grantSecret,request);expect(C.isCompanyExecutionSettlement(settled)).toBe(true);expect(await kernel.settleDepartmentExecution(o.input.grantSecret,request)).toEqual(settled);expect(settled.status).toBe('recovery_required');
  await expect(kernel.settleDepartmentExecution(o.input.grantSecret,{...request,note:'changed'})).rejects.toMatchObject({code:'conflict'});await expect(kernel.checkDepartmentExecution(o.input.grantSecret,check)).rejects.toMatchObject({code:'stale_claim'});
  const recovered=await kernel.recoverDepartmentCase(o.owner.sessionToken,{departmentId:o.department.id,caseId:o.item.id,requestId:randomUUID(),expectedFence:settled.fence,resolution:'released',note:'No external effect, explicitly reviewed.'});expect(recovered.item.status).toBe('open');
  await expect(kernel.admitDepartmentExecution(o.input.grantSecret,a)).rejects.toMatchObject({code:'stale_claim'});
  await expect(kernel.settleDepartmentExecution(o.input.grantSecret,request)).rejects.toMatchObject({code:'stale_claim'});
 });
 it('certificate changes and revoked sessions are separate from scoped background authority',async()=>{
  const o=await active(),a=admitInput(o.grant);await kernel.revokeSession(o.member.sessionToken);const r=await kernel.admitDepartmentExecution(o.input.grantSecret,a);expect(r.grantId).toBe(o.grant.id);
  await gate.run(async()=>{cert='d'.repeat(64);});try{await expect(kernel.checkDepartmentExecution(o.input.grantSecret,checkInput(a,r))).rejects.toMatchObject({code:'stale_claim'});}finally{await gate.run(async()=>{cert='a'.repeat(64);});}
 });
 it('keeps lookup RLS isolated on reused connections and immutable receipt/tombstone rows',async()=>{
  const o=await active(),a=admitInput(o.grant),r=await kernel.admitDepartmentExecution(o.input.grantSecret,a);await kernel.checkDepartmentExecution(o.input.grantSecret,checkInput(a,r));
  const client=await fixture.pool.connect();try{await client.query('BEGIN');expect((await client.query('SELECT id FROM realbud_company.department_execution_grants')).rows).toEqual([]);await expect(client.query('DELETE FROM realbud_company.department_execution_claims')).rejects.toMatchObject({code:'42501'});}finally{await client.query('ROLLBACK');client.release();}
  await expect(fixture.adminPool.query('UPDATE realbud_company.department_execution_claims SET dispatch_until=dispatch_until+interval \'1 second\' WHERE id=$1',[r.receiptId])).rejects.toThrow(/execution_record_immutable/);
 });
 it('restores inert grant/claim history, rotates host identity and preserves explicit recovery',async()=>{
  const o=await active(),a=admitInput(o.grant);await kernel.admitDepartmentExecution(o.input.grantSecret,a);
  // This shared fixture contains several companies, so isolate the source for
  // the existing one-office backup contract instead of weakening that check.
  const src=await startCompanyPostgresFixture({outputDirectory:join(directory,'restore-source')}),dest=await startCompanyPostgresFixture({outputDirectory:join(directory,'restore-target')});
  try{const k=createCompanyKernel(src.pool,{portalBridge:bridge}),owner=await k.createCompany({name:'Backup source',ownerName:'Owner'}),d=await k.createDepartment(owner.sessionToken,{requestId:randomUUID(),name:'Accounts'}),item=(await k.createDepartmentCase(owner.sessionToken,{requestId:randomUUID(),departmentId:d.id,title:'Backup case',description:'Local description',assigneeMemberId:owner.memberId})).item;
   const input:C.BeginCompanyExecution={...beginInput(o),requestId:randomUUID(),departmentId:d.id,expectedDepartmentRevision:d.revision,caseId:item.id,expectedCaseFence:item.fence},p=await k.beginDepartmentExecution(owner.sessionToken,input),g=await k.confirmDepartmentExecution(owner.sessionToken,{version:1,requestId:randomUUID(),grantId:p.id,expectedRevision:p.revision,grantDigest:p.digest}),admit=admitInput(g),r=await k.admitDepartmentExecution(input.grantSecret,admit);
   const backup=(await createOfficeBackup(src.adminPool,'A sufficiently long fictional passphrase',owner.companyId,true)).backup;expect(JSON.stringify(backup)).not.toContain(input.grantSecret);await restoreOfficeBackup(dest.adminPool,backup,'A sufficiently long fictional passphrase');
   const restored=createCompanyKernel(dest.pool,{portalBridge:bridge});await expect(restored.checkDepartmentExecution(input.grantSecret,checkInput(admit,r))).rejects.toMatchObject({code:'stale_claim'});
   expect((await dest.adminPool.query('SELECT status FROM realbud_company.cases')).rows[0].status).toBe('recovery_required');expect((await dest.adminPool.query('SELECT revoked_at FROM realbud_company.department_execution_grants')).rows[0].revoked_at).toBeInstanceOf(Date);
  }finally{await src.stop();await dest.stop();}
 },60000);
});
