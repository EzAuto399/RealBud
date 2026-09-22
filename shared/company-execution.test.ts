import { describe, expect, it } from 'vitest';
import {
  COMPANY_EXECUTION_PURPOSE, COMPANY_EXECUTION_GRANT_MS, COMPANY_EXECUTION_LEASE_MS,
  isCompanyExecutionSpec, isBeginCompanyExecution, isConfirmCompanyExecution, isRevokeCompanyExecution,
  isAdmitCompanyExecution, isCheckCompanyExecution, isRenewCompanyExecution, isSettleCompanyExecution,
  isCompanyExecutionGrant, isCompanyExecutionGrantPage, isCompanyExecutionReceipt,
  isCompanyExecutionCheck, isCompanyExecutionSettlement,
  type CompanyExecutionSpec, type CompanyExecutionGrant, type CompanyExecutionReceipt,
} from './company-execution.ts';

const id = (n:number) => `11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const digest = 'a'.repeat(64), secret = 'b'.repeat(64);
const createdAt = '2026-09-22T12:00:00.000Z', expiresAt = '2026-09-22T13:00:00.000Z';
const spec: CompanyExecutionSpec = {
  version:1,purpose:COMPANY_EXECUTION_PURPOSE,companyId:id(1),memberId:id(2),authorityId:id(3),
  certificateDigest:digest,departmentId:id(4),departmentRevision:'7',caseId:id(5),caseFence:'2',sourceDigest:digest,
  recipe:{id:'reviewed-recipe',revision:3,digest,instructionDigest:digest},
  executor:{workspaceId:'fictional-workspace',workerBinding:'fictional-worker-binding'},
};
const source = {caseId:spec.caseId,title:'Fictional company case',description:'Prepare a local draft only.'};
const begin = {version:1,requestId:id(6),grantSecret:secret,departmentId:spec.departmentId,expectedDepartmentRevision:'7',caseId:spec.caseId,expectedCaseFence:'2',recipe:spec.recipe,executor:spec.executor,durationMs:COMPANY_EXECUTION_GRANT_MS};
const confirm = {version:1,requestId:id(7),grantId:id(6),expectedRevision:'0',grantDigest:digest};
const revoke = {version:1,requestId:id(8),grantId:id(6),expectedRevision:'1',note:'Owner withdrew this preparation.'};
const admit = {version:1,grantId:id(6),requestId:id(9),executionId:id(10),claimSecret:secret,ttlMs:COMPANY_EXECUTION_LEASE_MS};
const check = {version:1,grantId:id(6),executionId:id(10),claimSecret:secret,fence:'3'};
const renew = {...check,requestId:id(11),ttlMs:COMPANY_EXECUTION_LEASE_MS};
const settle = {...check,requestId:id(12),runId:'fictional-run',outcome:'prepared',note:''};
const receipt: CompanyExecutionReceipt = {version:1,grantId:id(6),receiptId:id(9),executionId:id(10),caseId:spec.caseId,fence:'3',leaseExpiresAt:'2026-09-22T12:05:00.000Z',dispatchBefore:'2026-09-22T12:01:00.000Z'};
const grant: CompanyExecutionGrant = {id:id(6),revision:'1',phase:'active',current:true,spec,digest,departmentName:'Property operations',memberName:'Fictional member',source,createdAt,expiresAt,confirmedAt:createdAt,revokedAt:null};
const settlement = {receiptId:id(12),caseId:spec.caseId,fence:'4',status:'recovery_required',outcome:'prepared',runId:'fictional-run'};

describe('company execution authority contract',()=>{
  it('accepts the complete attended grant, bounded lease and recovery-only settlement',()=>{
    for(const [valid,value] of [
      [isCompanyExecutionSpec,spec],[isBeginCompanyExecution,begin],[isConfirmCompanyExecution,confirm],
      [isRevokeCompanyExecution,revoke],[isAdmitCompanyExecution,admit],[isCheckCompanyExecution,check],
      [isRenewCompanyExecution,renew],[isSettleCompanyExecution,settle],[isCompanyExecutionReceipt,receipt],
      [isCompanyExecutionCheck,{receipt,source}],[isCompanyExecutionSettlement,settlement],[isCompanyExecutionGrant,grant],
      [isCompanyExecutionGrantPage,{grants:[grant],offset:0,hasMore:false,canManage:true}],
    ] as const) expect(valid(value)).toBe(true);
  });

  it('requires own exact fields and excludes website/private scope and credentials',()=>{
    const inherited = Object.assign(Object.create({version:1}),begin);
    delete inherited.version;
    expect(isBeginCompanyExecution(inherited)).toBe(false);
    expect(isBeginCompanyExecution({...begin,memberToken:'x'.repeat(43)})).toBe(false);
    expect(isBeginCompanyExecution({...begin,recipe:{...begin.recipe,providerApiKey:'private'}})).toBe(false);
    expect(isCompanyExecutionSpec({...spec,purpose:'website-remote-work'})).toBe(false);
    expect(isCompanyExecutionSpec({...spec,purpose:'private-workspace'})).toBe(false);
    expect(isCompanyExecutionSpec({...spec,portalSubject:id(13)})).toBe(false);
    expect(isCompanyExecutionSpec({...spec,executor:{...spec.executor,scope:'private'}})).toBe(false);
    expect(isCompanyExecutionCheck({receipt,source,privateSource:'excluded'})).toBe(false);
  });

  it('separates execution secrets from member sessions and rejects version/ID coercion',()=>{
    for(const bad of ['x'.repeat(43),'a'.repeat(63),'a'.repeat(65),'A'.repeat(64),' '+secret,43]) {
      expect(isBeginCompanyExecution({...begin,grantSecret:bad})).toBe(false);
      expect(isCheckCompanyExecution({...check,claimSecret:bad})).toBe(false);
    }
    for(const bad of ['1',true,[1],null]) expect(isBeginCompanyExecution({...begin,version:bad})).toBe(false);
    expect(isBeginCompanyExecution({...begin,requestId:id(6).replace('-4111-','-5111-')})).toBe(false);
    expect(isCheckCompanyExecution({...check,executionId:'another-workspace'})).toBe(false);
    expect(isCompanyExecutionSpec({...spec,companyId:'website-account'})).toBe(false);
  });

  it('keeps bigint revisions exact and never accepts overflow or numeric approximations',()=>{
    expect(isConfirmCompanyExecution({...confirm,expectedRevision:'9223372036854775807'})).toBe(true);
    for(const bad of ['9223372036854775808','10000000000000000000','01','-1','1.0','1e2',1,Number.MAX_SAFE_INTEGER]) {
      expect(isConfirmCompanyExecution({...confirm,expectedRevision:bad})).toBe(false);
      expect(isCheckCompanyExecution({...check,fence:bad})).toBe(false);
      expect(isCompanyExecutionSpec({...spec,caseFence:bad})).toBe(false);
    }
  });

  it('bounds grant and lease duration independently, including renewal',()=>{
    for(const bad of [0,99,100.5,'100',Infinity,NaN]) {
      expect(isBeginCompanyExecution({...begin,durationMs:bad})).toBe(false);
      expect(isRenewCompanyExecution({...renew,ttlMs:bad})).toBe(false);
    }
    expect(isBeginCompanyExecution({...begin,durationMs:COMPANY_EXECUTION_GRANT_MS+1})).toBe(false);
    expect(isAdmitCompanyExecution({...admit,ttlMs:COMPANY_EXECUTION_LEASE_MS+1})).toBe(false);
    expect(isRenewCompanyExecution({...renew,ttlMs:COMPANY_EXECUTION_LEASE_MS+1})).toBe(false);
    expect(isRenewCompanyExecution({...renew,ttlMs:100})).toBe(true);
  });

  it('does not coerce arrays or objects into approved phases and outcomes',()=>{
    expect(isCompanyExecutionGrant({...grant,phase:['active']})).toBe(false);
    expect(isSettleCompanyExecution({...settle,outcome:['prepared']})).toBe(false);
    expect(isCompanyExecutionSettlement({...settlement,outcome:['prepared']})).toBe(false);
    expect(isCompanyExecutionSettlement({...settlement,status:'done'})).toBe(false);
    expect(isCompanyExecutionGrantPage({grants:[grant],offset:0,hasMore:false,canManage:'true'})).toBe(false);
  });

  it('rejects impossible dates, cross-case projections and a dispatch deadline after the lease',()=>{
    for(const bad of ['yesterday','2026-02-30T00:00:00.000Z','2026-09-22T12:00:00Z']) {
      expect(isCompanyExecutionReceipt({...receipt,leaseExpiresAt:bad})).toBe(false);
      expect(isCompanyExecutionGrant({...grant,expiresAt:bad})).toBe(false);
    }
    expect(isCompanyExecutionCheck({receipt,source:{...source,caseId:id(99)}})).toBe(false);
    expect(isCompanyExecutionGrant({...grant,source:{...source,caseId:id(99)}})).toBe(false);
    expect(isCompanyExecutionReceipt({...receipt,dispatchBefore:'2026-09-22T12:05:00.001Z'})).toBe(false);
    expect(isCompanyExecutionGrant({...grant,expiresAt:createdAt})).toBe(false);
    expect(isCompanyExecutionGrant({...grant,expiresAt:'2026-09-21T12:00:00.000Z'})).toBe(false);
  });

  it('requires confirmation and revocation evidence to agree with the grant phase',()=>{
    expect(isCompanyExecutionGrant({...grant,phase:'pending',confirmedAt:null})).toBe(true);
    expect(isCompanyExecutionGrant({...grant,phase:'admitted'})).toBe(true);
    expect(isCompanyExecutionGrant({...grant,phase:'revoked',current:false,revokedAt:createdAt})).toBe(true);
    expect(isCompanyExecutionGrant({...grant,confirmedAt:null})).toBe(false);
    expect(isCompanyExecutionGrant({...grant,phase:'pending'})).toBe(false);
    expect(isCompanyExecutionGrant({...grant,phase:'revoked',revokedAt:null})).toBe(false);
    expect(isCompanyExecutionGrant({...grant,phase:'revoked',current:true,revokedAt:createdAt})).toBe(false);
  });
});
