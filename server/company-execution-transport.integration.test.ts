import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as kernelModule from './company/index.ts';
import { startCompanyPostgresFixture } from './company/testing-postgres.ts';
import * as certificateModule from './company/host-certificate.ts';
import * as transportModule from './company/host-transport.ts';
import { createCompanyPortalCertificateGate } from './company/portal-proof.ts';
import * as hostModule from './company-host.ts';
import * as vaultModule from './private-vault.ts';
import * as clientModule from './company-execution-client.ts';
import type { CompanyExecutionGrant } from '../shared/company-execution.ts';

// The same behavioral suite can exercise emitted runtime modules. The PG
// fixture is source test infrastructure; every authority/client/transport below
// comes from the selected candidate when this option is present.
async function candidate<T>(source:T,path:string):Promise<T> { return process.env.REALBUD_TEST_RESOURCES ? await import(pathToFileURL(resolve(process.env.REALBUD_TEST_RESOURCES,'server',path)).href) as T : source; }
const { createCompanyKernel } = await candidate(kernelModule,'company/index.js');
const { createHostCertificate } = await candidate(certificateModule,'company/host-certificate.js');
const { companyCertificateFingerprint, requestCompanyHost, startCompanyTransport } = await candidate(transportModule,'company/host-transport.js');
const { createCompanyHost } = await candidate(hostModule,'company-host.js');
const { createPrivateVault } = await candidate(vaultModule,'private-vault.js');
const { createCompanyExecutionClient } = await candidate(clientModule,'company-execution-client.js');

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('encrypted department delegation client through real office TLS and PostgreSQL',()=>{
  let output:string, fixture:Awaited<ReturnType<typeof startCompanyPostgresFixture>>, transport:Awaited<ReturnType<typeof startCompanyTransport>>;
  let kernel:ReturnType<typeof createCompanyKernel>, cert:string;
  let officeOwner:Awaited<ReturnType<ReturnType<typeof createCompanyKernel>['createCompany']>>;
  beforeAll(async()=>{
    output=await mkdtemp(join(tmpdir(),'rb-execution-tls-'));
    fixture=await startCompanyPostgresFixture({outputDirectory:output,postgresBinDirectory:process.env.REALBUD_TEST_POSTGRES_BIN});
    const certificate=await createHostCertificate('localhost');cert=certificate.cert;
    kernel=createCompanyKernel(fixture.pool,{portalBridge:{withCertificate:createCompanyPortalCertificateGate().run,certificateDigest:()=>companyCertificateFingerprint(cert),verify:async()=>{throw Error('Mapping proof not used for execution delegation');}}});
    const host=createCompanyHost({kernel,authorizeAdmin:()=>({ok:false,status:401,error:'No service admin'}),hasAdminSession:()=>false});
    transport=await startCompanyTransport({...certificate,host:'127.0.0.1',port:0,handle:host.handle});
  },60000);
  afterAll(async()=>{await transport?.close();await fixture?.stop();if(output)await rm(output,{recursive:true,force:true});});
  function call(path:string,auth:{memberToken:string}|{executionToken:string},body?:unknown) {
    return requestCompanyHost({origin:`https://localhost:${transport.port}`,certificatePem:cert,path,method:path==='/api/company/me'?'GET':'POST',...auth,body});
  }
  async function office(){
    const owner=officeOwner??=await kernel.createCompany({name:'Fictional delegated office',ownerName:'Owner'});
    const invite=await kernel.issueInvitation(owner.sessionToken,{displayName:'Assigned member'}),member=await kernel.redeemInvitation(invite.invitationToken);
    let department=await kernel.createDepartment(owner.sessionToken,{requestId:randomUUID(),name:`Accounts ${randomUUID().slice(0,8)}`});
    department=await kernel.setDepartmentAccess(owner.sessionToken,{departmentId:department.id,memberId:member.memberId,expectedRevision:department.revision,access:'write'});
    const work=await kernel.createDepartmentCase(member.sessionToken,{departmentId:department.id,requestId:randomUUID(),title:'Review a synthetic case',description:'Only this selected case is a source.',assigneeMemberId:member.memberId});
    const directory=join(output,randomUUID()),vault=createPrivateVault(directory,randomBytes(32));
    const identity={companyId:owner.companyId,memberId:member.memberId,workspaceId:randomUUID(),workerBinding:'a'.repeat(64),certificateDigest:companyCertificateFingerprint(cert)};
    let lose='',clockOffset=0;const calls:Array<{path:string;body:unknown}>=[];
    const client=()=>createCompanyExecutionClient({vault,identity:async()=>({...identity}),now:()=>Date.now()+clockOffset,forward:async(path,auth,body)=>{
      calls.push({path,body:structuredClone(body)});const result=await call(path,auth,body);if(lose===path&&result.status===200){lose='';throw Error('Synthetic lost committed reply');}return result;
    }});
    const input={version:1 as const,requestId:randomUUID(),departmentId:department.id,expectedDepartmentRevision:department.revision,caseId:work.item.id,expectedCaseFence:work.item.fence,recipe:{id:'review-synthetic-case',revision:1,digest:'b'.repeat(64),instructionDigest:'c'.repeat(64)},durationMs:86400000};
    async function confirm(g:CompanyExecutionGrant){const result=await call('/api/company/execution-grants/confirm',{memberToken:owner.sessionToken},{version:1,requestId:randomUUID(),grantId:g.id,expectedRevision:g.revision,grantDigest:g.digest});expect(result.status).toBe(200);return result.body as CompanyExecutionGrant;}
    return {owner,member,department,work,directory,vault,identity,client,input,confirm,calls,loseNext:(path:string)=>{lose=path;},advanceClientClock:(ms:number)=>{clockOffset=ms;}};
  }
  it('survives lost grant and claim replies, then runs scoped checks after the member session is revoked',async()=>{
    const o=await office();o.loseNext('/api/company/execution-grants/begin');
    await expect(o.client().begin(o.member.sessionToken,o.input)).rejects.toThrow('Synthetic lost committed reply');
    const g=await o.client().begin(o.member.sessionToken,o.input);await o.confirm(g);
    const executions=randomUUID();o.loseNext('/api/company/execution/admit');
    await expect(o.client().admit(g.id,executions)).rejects.toThrow('Synthetic lost committed reply');
    await kernel.revokeSession(o.member.sessionToken);
    const receipt=await o.client().admit(g.id,executions);
    expect(receipt).toMatchObject({grantId:g.id,caseId:o.work.item.id,fence:'1',executionId:executions});
    expect(await o.client().beforeDispatch(g.id)).toMatchObject({source:{title:o.work.item.title,description:o.work.item.description}});
    for(const path of ['/api/company/execution-grants/begin','/api/company/execution/admit']){
      const attempts=o.calls.filter(c=>c.path===path);expect(attempts).toHaveLength(2);expect(attempts[0].body).toEqual(attempts[1].body);
    }
    const saved=await o.vault.read(`department-execution-${g.id}`) as {begin:{grantSecret:string};admission:{input:{claimSecret:string}}};
    const file=await readFile(join(o.directory,'company-installation','private',`department-execution-${g.id}.json`),'utf8');
    for(const value of [o.member.sessionToken,o.owner.sessionToken,saved.begin.grantSecret,saved.admission.input.claimSecret,o.work.item.description])expect(file).not.toContain(value);
    expect(JSON.stringify(saved)).not.toContain(o.member.sessionToken);
    expect((await call('/api/company/execution/check',{memberToken:o.owner.sessionToken},{version:1,grantId:g.id,executionId:executions,claimSecret:saved.admission.input.claimSecret,fence:receipt.fence})).status).toBe(401);
    expect((await call('/api/company/me',{memberToken:saved.begin.grantSecret})).status).toBe(401);
    await expect(call('/api/company/me',{executionToken:saved.begin.grantSecret})).rejects.toThrow('invalid execution credential');
  });
  it('recovers a lost begin by scoped status and observes owner confirmation then revocation over TLS',async()=>{
    const o=await office();o.loseNext('/api/company/execution-grants/begin');
    await expect(o.client().begin(o.member.sessionToken,o.input)).rejects.toThrow('Synthetic lost committed reply');
    await kernel.revokeSession(o.member.sessionToken);
    const pending=await o.client().status(o.input.requestId);expect(pending.phase).toBe('pending');
    expect(o.calls.filter(c=>c.path.endsWith('/begin'))).toHaveLength(1);
    expect((await o.client().local(pending.id)).grant).toEqual(pending);
    const confirmed=await o.confirm(pending);expect(await o.client().status(pending.id)).toEqual(confirmed);
    const revoked=await call('/api/company/execution-grants/revoke',{memberToken:o.owner.sessionToken},{version:1,grantId:pending.id,requestId:randomUUID(),expectedRevision:confirmed.revision,note:'Stop the pending background preparation'});
    expect(revoked.status).toBe(200);
    await fixture.adminPool.query('UPDATE realbud_company.cases SET description=$2 WHERE id=$1',[o.work.item.id,'Replacement case content must stay inaccessible']);
    const held=await o.client().status(pending.id);expect(held).toEqual(revoked.body);expect(held).toMatchObject({phase:'revoked',current:false,source:pending.source});
    const saved=await o.vault.read(`department-execution-${pending.id}`) as {begin:{grantSecret:string}};
    const target={version:1,grantId:pending.id};
    expect((await call('/api/company/execution/status',{memberToken:o.owner.sessionToken},target)).status).toBe(401);
    expect((await call('/api/company/execution/status',{executionToken:randomBytes(32).toString('hex')},target)).status).toBe(401);
    expect((await call('/api/company/execution/status',{executionToken:saved.begin.grantSecret},{...target,extra:true})).status).toBe(400);
    expect((await call('/api/company/execution/status',{executionToken:saved.begin.grantSecret},{...target,grantId:randomUUID()})).status).toBe(401);
    await expect(call('/api/company/execution-grants/list',{executionToken:saved.begin.grantSecret},{offset:0,limit:10})).rejects.toThrow('invalid execution credential');
    const page=await call('/api/company/execution-grants/list',{memberToken:o.owner.sessionToken},{offset:0,limit:10,departmentId:o.department.id});
    expect(page.status).toBe(200);expect((page.body as {grants:CompanyExecutionGrant[]}).grants.map(g=>g.id)).toEqual([pending.id]);
  });
  it('keeps the original start deadline through lost renewal replies and settles preparation into human review',async()=>{
    const o=await office(),client=o.client(),g=await client.begin(o.member.sessionToken,o.input);await o.confirm(g);
    const first=await client.admit(g.id,randomUUID());o.loseNext('/api/company/execution/renew');const renewal=randomUUID();
    await expect(client.renew(g.id,renewal)).rejects.toThrow('Synthetic lost committed reply');
    const renewed=await o.client().renew(g.id,renewal);expect(renewed.dispatchBefore).toBe(first.dispatchBefore);
    const attempts=o.calls.filter(c=>c.path==='/api/company/execution/renew');expect(attempts[0].body).toEqual(attempts[1].body);
    o.advanceClientClock(61000);await expect(o.client().beforeDispatch(g.id)).rejects.toMatchObject({code:'department_execution_held'});expect((await o.client().check(g.id)).source.caseId).toBe(o.work.item.id);
    const result={requestId:randomUUID(),runId:randomUUID(),outcome:'prepared' as const,note:'Synthetic preparation is ready for the assigned person to review.'};
    o.loseNext('/api/company/execution/settle');await expect(o.client().settle(g.id,result)).rejects.toThrow('Synthetic lost committed reply');
    const settled=await o.client().settle(g.id,result);expect(settled).toMatchObject({status:'recovery_required',fence:'2',outcome:'prepared'});
    const page=await kernel.departmentCases(o.owner.sessionToken,{departmentId:o.department.id,filter:'all'});
    expect(page.cases[0]).toMatchObject({status:'recovery_required',needsReview:true});
    await expect(o.client().check(g.id)).rejects.toMatchObject({code:'department_execution_held'});
  });
  it('holds scoped reads on permission loss and retains a failed settlement without touching a recovered case',async()=>{
    const o=await office(),client=o.client(),g=await client.begin(o.member.sessionToken,o.input);await o.confirm(g);await client.admit(g.id,randomUUID());
    await kernel.setDepartmentAccess(o.owner.sessionToken,{departmentId:o.department.id,memberId:o.member.memberId,expectedRevision:o.department.revision,access:'read'});
    await expect(client.check(g.id)).rejects.toMatchObject({code:'department_execution_held'});
    const current=(await kernel.departmentCases(o.owner.sessionToken,{departmentId:o.department.id})).cases[0];
    await kernel.recoverDepartmentCase(o.owner.sessionToken,{departmentId:o.department.id,caseId:current.id,expectedFence:current.fence,requestId:randomUUID(),resolution:'released',note:'Reviewed the interrupted synthetic execution.'});
    const result={requestId:randomUUID(),runId:randomUUID(),outcome:'interrupted' as const,note:'An actual executor result would be preserved here for attended reconciliation.'};
    await expect(client.settle(g.id,result)).rejects.toMatchObject({code:'department_execution_held'});
    const record=await o.vault.read(`department-execution-${g.id}`) as {settlement:{input:unknown;receipt?:unknown}};
    expect(record.settlement.input).toMatchObject(result);expect(record.settlement.receipt).toBeUndefined();
    expect((await kernel.departmentCases(o.owner.sessionToken,{departmentId:o.department.id,filter:'all'})).cases[0]).toMatchObject({status:'open',fence:'3'});
  });
});
