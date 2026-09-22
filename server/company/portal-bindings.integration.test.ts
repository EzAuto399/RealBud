import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanyKernel } from './index.ts';
import { createCompanyPortalProofVerifier, createCompanyPortalCertificateGate } from './portal-proof.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';
import type { CompanyPortalPerson, CompanyPortalProof, CompanyPortalRedeem, CompanyPortalBinding, AcceptCompanyPortalBinding } from '../../shared/company-portal.ts';
import { createOfficeBackup, restoreOfficeBackup } from './backup.ts';

describe.runIf(process.env.REALBUD_TEST_POSTGRES==='1')('attended company portal identity on real PostgreSQL',()=>{
 let fixture:Awaited<ReturnType<typeof startCompanyPostgresFixture>>,output:string;
 const certificateGate=createCompanyPortalCertificateGate();
 const issued=new Map<string,CompanyPortalProof>();const proofs=new Map<string,CompanyPortalPerson>();
 const calls:CompanyPortalRedeem[]=[];
 let cert:string|null='a'.repeat(64),beforeReply:((input:CompanyPortalRedeem)=>Promise<void>)|undefined;
 const verify=createCompanyPortalProofVerifier({fetch:async(_url,init)=>{
  const input=JSON.parse(String(init?.body)) as CompanyPortalRedeem;calls.push(input);
  await beforeReply?.(input);
  if(!proofs.has(input.proofHandle))return new Response('{}',{status:403,headers:{'content-type':'application/json'}});
  let proof=issued.get(input.proofHandle);
  if(!proof){const t=Date.now();proof={version:1,issuer:'https://realbud.app',receiptId:randomUUID(),requestId:randomUUID(),redemptionId:input.redemptionId,target:input.target,person:proofs.get(input.proofHandle)!,issuedAt:new Date(t-1).toISOString(),expiresAt:new Date(Math.min(t+59000,Date.parse(input.target.expiresAt))).toISOString()};issued.set(input.proofHandle,proof);}
  return Response.json(proof);
 }});
 let kernel:ReturnType<typeof createCompanyKernel>;
 beforeAll(async()=>{output=await mkdtemp(join(tmpdir(),'rb-company-portal-'));fixture=await startCompanyPostgresFixture({outputDirectory:output,postgresBinDirectory:process.env.REALBUD_TEST_POSTGRES_BIN});kernel=createCompanyKernel(fixture.pool,{portalBridge:{withCertificate:certificateGate.run,certificateDigest:()=>cert,verify}});},60000);
 afterAll(async()=>{await fixture?.stop();if(output)await rm(output,{recursive:true,force:true});});
 const person=(companyId='portal-office'):CompanyPortalPerson=>({subject:randomUUID(),providerIssuer:'https://identity.example.test',providerSubject:randomUUID(),accountId:randomUUID(),companyId,identityEpoch:1,email:'person@example.test',agencyLabel:'Fictional company'});
 const handle=(p:CompanyPortalPerson)=>{const key=randomBytes(32).toString('hex');proofs.set(key,p);return key;};
 async function office(){const owner=await kernel.createCompany({name:'Fictional portal office',ownerName:'Owner'});const invitation=await kernel.issueInvitation(owner.sessionToken,{displayName:'Member'});const member=await kernel.redeemInvitation(invitation.invitationToken);return {owner,member};}
 const begin=(o:Awaited<ReturnType<typeof office>>)=>kernel.beginPortalMemberBinding(o.owner.sessionToken,{version:1,requestId:randomUUID(),memberId:o.member.memberId});
 const attempt=(b:CompanyPortalBinding,p:CompanyPortalPerson):AcceptCompanyPortalBinding=>({version:1,bindingId:b.id,requestId:randomUUID(),expectedRevision:b.revision,proofHandle:handle(p)});
 const revoke=(b:CompanyPortalBinding)=>({version:1 as const,bindingId:b.id,requestId:randomUUID(),expectedRevision:b.revision,note:'Attended withdrawal'});
 it('binds once with member consent and independent owner proof, projecting no provider/session details',async()=>{
  const o=await office(),b=await begin(o),p=person(),a=attempt(b,p);
  expect(b).toMatchObject({phase:'pending',revision:'0',current:true,person:null});expect(b.mapTarget.challengeHash).not.toBe(b.confirmTarget.challengeHash);
  const c=await kernel.acceptPortalMemberBinding(o.member.sessionToken,a);expect(c).toMatchObject({phase:'candidate',revision:'1'});
  const confirmation=attempt(c,p),done=await kernel.confirmPortalMemberBinding(o.owner.sessionToken,confirmation);expect(done).toMatchObject({phase:'confirmed',revision:'2',current:true});
  expect(await kernel.acceptPortalMemberBinding(o.member.sessionToken,a)).toEqual(done);expect(await kernel.confirmPortalMemberBinding(o.owner.sessionToken,confirmation)).toEqual(done);
  const view=JSON.stringify(done);for(const secret of [p.providerSubject,p.accountId,a.proofHandle,confirmation.proofHandle])expect(view).not.toContain(secret);
  const anchor=(await fixture.adminPool.query('SELECT portal_issuer,portal_company_id FROM realbud_company.companies WHERE id=$1',[o.owner.companyId])).rows[0];expect(anchor).toEqual({portal_issuer:'https://realbud.app',portal_company_id:p.companyId});
  expect(calls.filter(x=>x.proofHandle===a.proofHandle)).toHaveLength(2);
 });
 it('rejects unconfigured hosts and nonowner creation before any proof/network operation',async()=>{
  const o=await office(),n=calls.length;
  await expect(kernel.beginPortalMemberBinding(o.member.sessionToken,{version:1,requestId:randomUUID(),memberId:o.member.memberId})).rejects.toMatchObject({code:'forbidden'});
  cert=null;try{await expect(begin(o)).rejects.toMatchObject({code:'recovery_required'});}finally{cert='a'.repeat(64);}
  expect(calls).toHaveLength(n);
 });
 it('requires the selected member, original current owner and exact company at both phases',async()=>{
  const o=await office(),foreign=await office(),b=await begin(o),p=person(),a=attempt(b,p),n=calls.length;
  await expect(kernel.acceptPortalMemberBinding(o.owner.sessionToken,a)).rejects.toMatchObject({code:'forbidden'});
  await expect(kernel.acceptPortalMemberBinding(foreign.member.sessionToken,a)).rejects.toMatchObject({code:'not_found'});expect(calls).toHaveLength(n);
  const c=await kernel.acceptPortalMemberBinding(o.member.sessionToken,a);
  await expect(kernel.confirmPortalMemberBinding(o.member.sessionToken,attempt(c,p))).rejects.toMatchObject({code:'forbidden'});
  const transfer=await kernel.offerOwnership(o.owner.sessionToken,o.member.memberId);await kernel.acceptOwnership(o.member.sessionToken,transfer.id);
  await expect(kernel.confirmPortalMemberBinding(o.owner.sessionToken,attempt(c,p))).rejects.toMatchObject({code:'not_found'});
  await expect(kernel.confirmPortalMemberBinding(o.member.sessionToken,attempt(c,p))).rejects.toMatchObject({code:'forbidden'});
 });
 it('retains begin and failed redemption intent, exact retry IDs and immutable deadlines across restart',async()=>{
  const o=await office(),input={version:1 as const,requestId:randomUUID(),memberId:o.member.memberId};const b=await kernel.beginPortalMemberBinding(o.owner.sessionToken,input);
  expect(await kernel.beginPortalMemberBinding(o.owner.sessionToken,input)).toEqual(b);
  const p=person(),a=attempt(b,p);proofs.delete(a.proofHandle);
  await expect(kernel.acceptPortalMemberBinding(o.member.sessionToken,a)).rejects.toMatchObject({code:'portal_proof_denied'});
  const stored=(await fixture.adminPool.query('SELECT map_request,map_redemption_id FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rows[0];expect(stored.map_request.proofHandle).toBeUndefined();expect(stored.map_request.proofHandleHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(kernel.acceptPortalMemberBinding(o.member.sessionToken,{...a,proofHandle:handle(p)})).rejects.toMatchObject({code:'conflict'});
  proofs.set(a.proofHandle,p);const reopened=createCompanyKernel(fixture.pool,{portalBridge:{withCertificate:certificateGate.run,certificateDigest:()=>cert,verify}});const c=await reopened.acceptPortalMemberBinding(o.member.sessionToken,a);expect(c.mapTarget.expiresAt).toBe(b.mapTarget.expiresAt);
  expect(calls.filter(x=>x.proofHandle===a.proofHandle).map(x=>x.redemptionId)).toEqual([stored.map_redemption_id,stored.map_redemption_id]);
 });
 it('rechecks certificate, session and member revocation after external verification',async()=>{
  for(const mutation of ['certificate','session','member'] as const){const o=await office(),b=await begin(o),a=attempt(b,person());
   beforeReply=async()=>{beforeReply=undefined;if(mutation==='certificate')await certificateGate.run(async()=>{cert='b'.repeat(64);});else if(mutation==='session')await kernel.revokeSession(o.member.sessionToken);else await kernel.revokeMember(o.owner.sessionToken,o.member.memberId);};
   try{await expect(kernel.acceptPortalMemberBinding(o.member.sessionToken,a)).rejects.toMatchObject({code:mutation==='certificate'?'conflict':'unauthenticated'});}finally{cert='a'.repeat(64);beforeReply=undefined;}
   expect((await fixture.adminPool.query('SELECT candidate_proof FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rows[0].candidate_proof).toBeNull();
  }
 });
 it('does not accept an unbranded proof object even when every field has the right shape',async()=>{
  const o=await office(),b=await begin(o),p=person(),a=attempt(b,p);
  const unsafe=createCompanyKernel(fixture.pool,{portalBridge:{withCertificate:certificateGate.run,certificateDigest:()=>cert,verify:async input=>({version:1,issuer:'https://realbud.app',receiptId:randomUUID(),requestId:randomUUID(),redemptionId:input.redemptionId,target:input.target,person:p,issuedAt:new Date(Date.now()-100).toISOString(),expiresAt:new Date(Date.now()+50000).toISOString()}) as never}});
  await expect(unsafe.acceptPortalMemberBinding(o.member.sessionToken,a)).rejects.toMatchObject({code:'portal_proof_denied'});
 });
 async function waitForBlockedBindingRead(){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
   const row=(await fixture.adminPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF b%' AND pid<>pg_backend_pid()")).rows[0];
   if(row.n>0)return;await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('No final binding row read was observed waiting');
 }
 it.each(['member-map','member-confirm'] as const)('rechecks a certificate changed outside the gate during the final %s row wait',async purpose=>{
  const o=await office(),p=person();let b=await begin(o);
  if(purpose==='member-confirm')b=await kernel.acceptPortalMemberBinding(o.member.sessionToken,attempt(b,p));
  const a=attempt(b,p),holder=await fixture.adminPool.connect();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  beforeReply=async()=>{beforeReply=undefined;await holder.query('BEGIN');await holder.query('SELECT id FROM realbud_company.portal_member_bindings WHERE id=$1 FOR UPDATE',[b.id]);entered();};
  const pending=purpose==='member-map'?kernel.acceptPortalMemberBinding(o.member.sessionToken,a):kernel.confirmPortalMemberBinding(o.owner.sessionToken,a);pending.catch(()=>{});
  try{
   await ready;await waitForBlockedBindingRead();
   // Deliberately bypass the gate to model natural certificate expiry or a
   // misbehaving callback. A cached digest must still never pass this read.
   cert='b'.repeat(64);await holder.query('COMMIT');
   await expect(pending).rejects.toMatchObject({code:'conflict'});
   const row=(await fixture.adminPool.query('SELECT candidate_proof,confirm_proof FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rows[0];
   expect(purpose==='member-map'?row.candidate_proof:row.confirm_proof).toBeNull();
  }finally{beforeReply=undefined;await holder.query('ROLLBACK');holder.release();cert='a'.repeat(64);}
 });
 it('holds certificate rotation until the complete admitted mapping transaction commits',async()=>{
  const o=await office(),b=await begin(o),a=attempt(b,person()),holder=await fixture.adminPool.connect();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  beforeReply=async()=>{beforeReply=undefined;await holder.query('BEGIN');await holder.query('SELECT id FROM realbud_company.portal_member_bindings WHERE id=$1 FOR UPDATE',[b.id]);entered();};
  const pending=kernel.acceptPortalMemberBinding(o.member.sessionToken,a);pending.catch(()=>{});let rotation:Promise<void>|undefined,rotated=false;
  try{
   await ready;await waitForBlockedBindingRead();
   rotation=certificateGate.run(async()=>{
    // A separate connection must observe COMMIT, not merely the callback's
    // pending UPDATE, before the rotation can enter its protected section.
    expect((await fixture.adminPool.query('SELECT candidate_proof FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rows[0].candidate_proof).not.toBeNull();
    cert='b'.repeat(64);rotated=true;
   });rotation.catch(()=>{});
   expect(rotated).toBe(false);await holder.query('COMMIT');expect((await pending).phase).toBe('candidate');await rotation;
   expect((await kernel.listPortalMemberBindings(o.member.sessionToken,{offset:0,limit:10})).bindings[0].current).toBe(false);
  }finally{beforeReply=undefined;await holder.query('ROLLBACK');holder.release();await rotation;cert='a'.repeat(64);}
 });
 it('lets rotation finish during external redemption and holds the later final transaction',async()=>{
  const o=await office(),b=await begin(o),a=attempt(b,person());let release!:()=>void,entered!:()=>void,rotation:Promise<void>|undefined;
  const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  beforeReply=async()=>{beforeReply=undefined;rotation=certificateGate.run(async()=>{entered();await hold;cert='b'.repeat(64);});await ready;};
  const pending=kernel.acceptPortalMemberBinding(o.member.sessionToken,a);pending.catch(()=>{});
  try{
   await ready;release();await rotation;await expect(pending).rejects.toMatchObject({code:'conflict'});
   expect((await fixture.adminPool.query('SELECT candidate_proof FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rows[0].candidate_proof).toBeNull();
  }finally{beforeReply=undefined;release();await rotation;cert='a'.repeat(64);}
 });
 it('requires exact person confirmation and anchors the local office to the first portal company',async()=>{
  const o=await office(),b=await begin(o),p=person(),c=await kernel.acceptPortalMemberBinding(o.member.sessionToken,attempt(b,p));
  await expect(kernel.confirmPortalMemberBinding(o.owner.sessionToken,attempt(c,{...p,identityEpoch:2}))).rejects.toMatchObject({code:'conflict'});
  await kernel.revokePortalMemberBinding(o.owner.sessionToken,revoke(c));
  const next=await begin(o),candidate=await kernel.acceptPortalMemberBinding(o.member.sessionToken,attempt(next,p));await kernel.confirmPortalMemberBinding(o.owner.sessionToken,attempt(candidate,p));
  const invitation=await kernel.issueInvitation(o.owner.sessionToken,{displayName:'Second member'}),second=await kernel.redeemInvitation(invitation.invitationToken);
  const other=await kernel.beginPortalMemberBinding(o.owner.sessionToken,{version:1,requestId:randomUUID(),memberId:second.memberId});
  await expect(kernel.acceptPortalMemberBinding(second.sessionToken,attempt(other,person('another-portal-office')))).rejects.toMatchObject({code:'conflict'});
 });
 it('revocation is terminal, retries are exact, and historical people cannot move to another member',async()=>{
  const o=await office(),b=await begin(o),p=person(),a=attempt(b,p),c=await kernel.acceptPortalMemberBinding(o.member.sessionToken,a),done=await kernel.confirmPortalMemberBinding(o.owner.sessionToken,attempt(c,p));
  const r=revoke(done),revoked=await kernel.revokePortalMemberBinding(o.member.sessionToken,r);expect(revoked).toMatchObject({phase:'revoked',current:false});expect(await kernel.revokePortalMemberBinding(o.member.sessionToken,r)).toEqual(revoked);
  await expect(kernel.acceptPortalMemberBinding(o.member.sessionToken,a)).rejects.toMatchObject({code:'conflict'});
  const invitation=await kernel.issueInvitation(o.owner.sessionToken,{displayName:'Other person'}),other=await kernel.redeemInvitation(invitation.invitationToken);
  const n=await kernel.beginPortalMemberBinding(o.owner.sessionToken,{version:1,requestId:randomUUID(),memberId:other.memberId}),candidate=await kernel.acceptPortalMemberBinding(other.sessionToken,attempt(n,p));
  await expect(kernel.confirmPortalMemberBinding(o.owner.sessionToken,attempt(candidate,p))).rejects.toMatchObject({code:'conflict'});
 });
 it('enforces owner/self RLS and paginated safe views, including missing certificate holds',async()=>{
  const o=await office(),b=await begin(o),foreign=await office();
  expect((await kernel.listPortalMemberBindings(o.owner.sessionToken,{offset:0,limit:1}))).toMatchObject({canManage:true,hasMore:false,bindings:[{id:b.id}]});
  expect((await kernel.listPortalMemberBindings(o.member.sessionToken,{offset:0,limit:1})).bindings).toHaveLength(1);
  expect((await kernel.listPortalMemberBindings(foreign.owner.sessionToken,{offset:0,limit:1})).bindings).toEqual([]);
  cert=null;try{expect((await kernel.listPortalMemberBindings(o.member.sessionToken,{offset:0,limit:1})).bindings[0].current).toBe(false);}finally{cert='a'.repeat(64);}
  const client=await fixture.pool.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('realbud.company_id',$1,true),set_config('realbud.member_id',$2,true)",[foreign.owner.companyId,foreign.owner.memberId]);expect((await client.query('SELECT * FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rows).toEqual([]);await expect(client.query('DELETE FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rejects.toMatchObject({code:'42501'});}finally{await client.query('ROLLBACK');client.release();}
 });
 async function waitForBlockedCompanyTransaction(){const deadline=Date.now()+5000;while(Date.now()<deadline){const row=(await fixture.adminPool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'")).rows[0];if(row.n>0)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('No company transaction was observed waiting on its advisory lock');}
 it('rechecks member revocation after a real competing transaction held the final admission lock',async()=>{
  const o=await office(),b=await begin(o),a=attempt(b,person()),holder=await fixture.adminPool.connect();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  beforeReply=async()=>{beforeReply=undefined;await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`company-lifecycle:${o.owner.companyId}`]);await holder.query('UPDATE realbud_company.members SET active=false WHERE company_id=$1 AND id=$2',[o.owner.companyId,o.member.memberId]);entered();};
  const pending=kernel.acceptPortalMemberBinding(o.member.sessionToken,a);pending.catch(()=>{});
  try{await ready;await waitForBlockedCompanyTransaction();await holder.query('COMMIT');await expect(pending).rejects.toMatchObject({code:'unauthenticated'});expect((await fixture.adminPool.query('SELECT candidate_proof FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rows[0].candidate_proof).toBeNull();}finally{beforeReply=undefined;await holder.query('ROLLBACK');holder.release();}
 });
 it('rechecks the exact proof deadline after waiting and preserves the original reserved intent',async()=>{
  const o=await office(),b=await begin(o),a=attempt(b,person()),holder=await fixture.adminPool.connect();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const clock=(await fixture.adminPool.query("SELECT pg_get_functiondef('pg_catalog.clock_timestamp()'::regprocedure) AS def")).rows[0].def;
  beforeReply=async()=>{beforeReply=undefined;await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`company-lifecycle:${o.owner.companyId}`]);entered();};
  const pending=kernel.acceptPortalMemberBinding(o.member.sessionToken,a);pending.catch(()=>{});
  try{await ready;await waitForBlockedCompanyTransaction();const deadline=issued.get(a.proofHandle)!.expiresAt;
   await fixture.adminPool.query(`CREATE OR REPLACE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE PARALLEL SAFE AS $$SELECT '${deadline}'::timestamptz$$`);
   await holder.query('COMMIT');await expect(pending).rejects.toMatchObject({code:'portal_proof_stale'});
   const row=(await fixture.adminPool.query('SELECT candidate_proof,map_request FROM realbud_company.portal_member_bindings WHERE id=$1',[b.id])).rows[0];expect(row.candidate_proof).toBeNull();expect(row.map_request.requestId).toBe(a.requestId);
  }finally{beforeReply=undefined;await holder.query('ROLLBACK');holder.release();await fixture.adminPool.query(clock);}
 });
 it('does not reuse an operation UUID across another member binding or department mutation',async()=>{
  const o=await office(),b=await begin(o),a=attempt(b,person());await kernel.acceptPortalMemberBinding(o.member.sessionToken,a);
  const invitation=await kernel.issueInvitation(o.owner.sessionToken,{displayName:'Second member'}),second=await kernel.redeemInvitation(invitation.invitationToken),next=await kernel.beginPortalMemberBinding(o.owner.sessionToken,{version:1,requestId:randomUUID(),memberId:second.memberId});
  await expect(kernel.acceptPortalMemberBinding(second.sessionToken,{...attempt(next,person()),requestId:a.requestId})).rejects.toMatchObject({code:'conflict'});
  const department=await kernel.createDepartment(o.owner.sessionToken,{requestId:randomUUID(),name:'Department operation test'});
  await expect(kernel.createDepartmentCase(o.owner.sessionToken,{departmentId:department.id,requestId:b.id,title:'Cannot alias binding receipt',description:'Fictional',assigneeMemberId:null})).rejects.toMatchObject({code:'conflict'});
 });
 it('keeps immutable anchors and revoked history against direct backend updates',async()=>{
  const o=await office(),b=await begin(o),p=person(),c=await kernel.acceptPortalMemberBinding(o.member.sessionToken,attempt(b,p)),d=await kernel.confirmPortalMemberBinding(o.owner.sessionToken,attempt(c,p));await kernel.revokePortalMemberBinding(o.owner.sessionToken,revoke(d));
  await expect(fixture.adminPool.query('UPDATE realbud_company.portal_member_bindings SET revoked_at=NULL WHERE id=$1',[b.id])).rejects.toThrow(/portal_binding_immutable/);
  await expect(fixture.adminPool.query('UPDATE realbud_company.companies SET portal_company_id=$2 WHERE id=$1',[o.owner.companyId,'replacement'])).rejects.toThrow(/portal_anchor_immutable/);
  const client=await fixture.pool.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('realbud.company_id',$1,true),set_config('realbud.member_id',$2,true)",[o.owner.companyId,o.owner.memberId]);await expect(client.query('UPDATE realbud_company.companies SET remote_authority_incarnation=$2 WHERE id=$1',[o.owner.companyId,randomUUID()])).rejects.toMatchObject({code:'42501'});}finally{await client.query('ROLLBACK');client.release();}
 });
 it('restores evidence and anchors while rotating authority and revoking every mapping',async()=>{
  const source=await startCompanyPostgresFixture({outputDirectory:join(output,'backup-source'),postgresBinDirectory:process.env.REALBUD_TEST_POSTGRES_BIN});const target=await startCompanyPostgresFixture({outputDirectory:join(output,'backup-target'),postgresBinDirectory:process.env.REALBUD_TEST_POSTGRES_BIN});
  try{const k=createCompanyKernel(source.pool,{portalBridge:{withCertificate:certificateGate.run,certificateDigest:()=>cert,verify}}),owner=await k.createCompany({name:'Backup office',ownerName:'Owner'});const b=await k.beginPortalMemberBinding(owner.sessionToken,{version:1,requestId:randomUUID(),memberId:owner.memberId}),p=person(),c=await k.acceptPortalMemberBinding(owner.sessionToken,attempt(b,p)),d=await k.confirmPortalMemberBinding(owner.sessionToken,attempt(c,p));
   const backup=(await createOfficeBackup(source.adminPool,'Fictional sufficiently long passphrase',owner.companyId,true)).backup;await restoreOfficeBackup(target.adminPool,backup,'Fictional sufficiently long passphrase');
   const restored=(await target.adminPool.query('SELECT b.*,c.remote_authority_incarnation,c.portal_company_id FROM realbud_company.portal_member_bindings b JOIN realbud_company.companies c ON c.id=b.company_id')).rows[0];expect(restored.candidate_proof.person).toEqual(p);expect(restored.revoked_at).toBeInstanceOf(Date);expect(restored.revision).toBe(String(Number(d.revision)+1));expect(restored.remote_authority_incarnation).not.toBe(d.mapTarget.authorityId);expect(restored.portal_company_id).toBe(p.companyId);await expect(createCompanyKernel(target.pool).authenticateSession(owner.sessionToken)).rejects.toMatchObject({code:'unauthenticated'});
  }finally{await source.stop();await target.stop();}
 },60000);
});
