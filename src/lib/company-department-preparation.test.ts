import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store',()=>({api:vi.fn()}));
import { createCompanyApi, isDepartmentPreparationState } from './company-api';
import { canRequestDepartmentPreparation, DepartmentPreparationReview, DepartmentPreparationResult, isDepartmentPreparationOperation } from '../components/CompanyDepartmentPreparation';
import type { CompanyStatus, DepartmentCasePage, DepartmentCase } from '@shared/company-api';
import type { CompanyExecutionReview, CompanyExecutionGrant } from '@shared/company-execution';
import type { DepartmentWorkPrepare, DepartmentWorkState } from '@shared/department-work';
import { COMPANY_EXECUTION_PURPOSE } from '@shared/company-execution';
import { JOB_OUTPUT_MAX_CHARS, JOB_OUTPUT_TOTAL_CHARS } from '@shared/job-output';
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const digest='a'.repeat(64),token='fictional_member_session_1234567890';
const review:CompanyExecutionReview={plan:{title:'Analyse this assigned case',description:'Read only the shared case description.',steps:['Analyse the case','Draft the result for human review'],evidence:'A written draft',capabilities:['analyse','draft'],allowedOrigins:[],limits:{maxRuntimeMinutes:5,maxTurns:12},siteNotes:null},instructions:'Use only the assigned case. Do not send or submit anything.'};
const prepare:DepartmentWorkPrepare={version:1,requestId:id(1),departmentId:id(2),expectedDepartmentRevision:'4',caseId:id(3),expectedCaseFence:'6',recipeId:'case-draft',expectedRecipeRevision:2,durationMs:86400000};
const local:DepartmentWorkState={grantId:prepare.requestId,executionId:id(4),caseId:prepare.caseId,request:prepare,phase:'waiting-owner',detail:'Waiting for owner approval.',runId:null,updatedAt:1,result:null};
const grant:CompanyExecutionGrant={id:prepare.requestId,revision:'0',phase:'pending',current:true,spec:{version:1,purpose:COMPANY_EXECUTION_PURPOSE,companyId:id(5),memberId:id(6),authorityId:id(7),certificateDigest:digest,departmentId:prepare.departmentId,departmentRevision:prepare.expectedDepartmentRevision,caseId:prepare.caseId,caseFence:prepare.expectedCaseFence,sourceDigest:digest,recipe:{id:prepare.recipeId,revision:2,digest,instructionDigest:digest,review},executor:{workspaceId:id(8),workerBinding:'b'.repeat(64)}},digest,departmentName:'Accounts',memberName:'Fictional member',source:{caseId:prepare.caseId,title:'Fictional case',description:'Shared case details'},createdAt:'2026-09-22T12:00:00.000Z',expiresAt:'2026-09-23T12:00:00.000Z',confirmedAt:null,revokedAt:null};
const page={grants:[grant],offset:0,hasMore:false,canManage:false,local:[local]};
const session={memberToken:token,company:{id:id(5),name:'Fictional company'},member:{id:id(6),displayName:'Fictional member',role:'member'}};
const status:CompanyStatus={storageAvailable:true,configured:true,setupAllowed:false,transport:'encrypted-company',remoteHost:true,company:session.company,member:{...session.member,role:'member'},limitations:[]};
async function signed(response:unknown){const request=vi.fn().mockResolvedValueOnce(session).mockResolvedValue(response);const client=createCompanyApi(request);await client.signIn({loginName:'fictional',password:'Fictional-password-only'});return{client,request};}
const item:DepartmentCase={id:prepare.caseId,title:'Assigned case',description:'Details',status:'open',fence:'6',assignee:{id:id(6),displayName:'Fictional member',active:true,canWrite:true},needsAssignment:false,canAssign:false,canClose:true,holder:null,leaseExpiresAt:null,createdAt:'2026-09-22T12:00:00.000Z',needsReview:false,lastRecovery:null,lastClosure:null};
const cases:DepartmentCasePage={department:{id:prepare.departmentId,name:'Accounts',revision:'4',access:'write',retiredAt:null,retiredBy:null,retirementNote:'',unresolvedCases:1},cases:[item],canRecover:false,canCreate:true,filter:'all',offset:0,hasMore:false};

describe('department preparation UI and API boundary',()=>{
 it('uses the current member session and exact prepare body without generating a replacement ID',async()=>{
  const {client,request}=await signed({grant,local});expect(await client.prepareDepartmentWork(prepare)).toEqual({grant,local});
  const [path,init]=request.mock.calls[1];expect(path).toBe('/api/company/department-work/prepare');expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual(prepare);expect(new Headers(init.headers).get('x-realbud-member-session')).toBe(token);expect(init.body).not.toContain(token);
  request.mockResolvedValue({grant,local});await client.prepareDepartmentWork(prepare);expect(request.mock.calls[2][1].body).toBe(init.body);
 });
 it('sends owner decisions with the exact reviewed grant digest/revision and result reconciliation without a prepare action',async()=>{
  const active={...grant,phase:'active',revision:'1',confirmedAt:grant.createdAt};const {client,request}=await signed(active);
  const confirmation={version:1 as const,requestId:id(9),grantId:grant.id,expectedRevision:'0',grantDigest:grant.digest};
  await client.confirmDepartmentPreparation(confirmation);expect(request.mock.calls[1][0]).toBe('/api/company/department-work/confirm');expect(JSON.parse(request.mock.calls[1][1].body)).toEqual(confirmation);
  request.mockResolvedValue(local);await client.reconcileDepartmentPreparation(grant.id);expect(request.mock.calls[2][0]).toBe('/api/company/department-work/reconcile');expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({grantId:grant.id});
 });
 it('rejects cross-department, cross-case and secret-bearing records instead of displaying them',async()=>{
  const {client,request}=await signed(page);
  expect(await client.departmentPreparations(prepare.departmentId)).toEqual(page);
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({departmentId:prepare.departmentId,offset:0,limit:10});
  for(const bad of [
   {...page,grants:[{...grant,spec:{...grant.spec,departmentId:id(99)}}]},
   {...page,local:[{...local,caseId:id(99)}]},
   {...page,local:[{...local,request:{...prepare,departmentId:id(99)}}]},
   {...page,local:[{...local,grantSecret:'private'}]},
   {...page,grants:[grant,grant]},
  ]){request.mockResolvedValue(bad);await expect(client.departmentPreparations(prepare.departmentId)).rejects.toThrow('incomplete response');}
  request.mockResolvedValue({grant,local:{...local,request:{...prepare,expectedCaseFence:'8'}}});await expect(client.prepareDepartmentWork(prepare)).rejects.toThrow('incomplete response');
 });
 it('requires complete bounded reviews and outputs, with strict state rather than coercion',async()=>{
  const {client,request}=await signed({recipes:[{id:'case-draft',revision:2,title:'Case draft',review}]});
  expect((await client.departmentPreparationCatalog(prepare.departmentId)).recipes).toHaveLength(1);
  request.mockResolvedValue({recipes:[{id:'case-draft',revision:2,title:'Case draft',review:{...review,plan:{...review.plan,capabilities:['send']}}}]});
  await expect(client.departmentPreparationCatalog(prepare.departmentId)).rejects.toThrow('incomplete response');
  expect(isDepartmentPreparationState({...local,phase:['running']})).toBe(false);
  const result={status:'prepared',detail:'Draft only',outputs:['x'.repeat(JOB_OUTPUT_MAX_CHARS)]};expect(isDepartmentPreparationState({...local,result})).toBe(true);
  expect(isDepartmentPreparationState({...local,result:{...result,outputs:['x'.repeat(JOB_OUTPUT_MAX_CHARS+1)]}})).toBe(false);
  expect(isDepartmentPreparationState({...local,result:{...result,outputs:Array.from({length:3},()=> 'x'.repeat(Math.ceil(JOB_OUTPUT_TOTAL_CHARS/3)+1))}})).toBe(false);
 });
 it('does not retry a network failure or adopt a late response after company sign-out',async()=>{
  const {client,request}=await signed(page);request.mockRejectedValueOnce(new Error('private provider diagnostic'));
  await expect(client.prepareDepartmentWork(prepare)).rejects.not.toThrow('private provider');expect(request.mock.calls.filter(([path])=>path.endsWith('/prepare'))).toHaveLength(1);
  let reply:(value:unknown)=>void=()=>{};request.mockImplementationOnce(()=>new Promise(resolve=>{reply=resolve;}));
  const pending=client.departmentPreparations(prepare.departmentId);request.mockResolvedValueOnce({ok:true});await client.logout();reply(page);
  await expect(pending).rejects.toThrow();
 });
 it('shows request eligibility only for an open assigned case with current member editing access',()=>{
  expect(canRequestDepartmentPreparation(cases,item,status)).toBe(true);
  for(const altered of [{...item,status:'claimed' as const},{...item,needsReview:true},{...item,assignee:{...item.assignee!,id:id(99)}},{...item,assignee:{...item.assignee!,canWrite:false}},{...item,assignee:{...item.assignee!,active:false}}])expect(canRequestDepartmentPreparation(cases,altered,status)).toBe(false);
  expect(canRequestDepartmentPreparation({...cases,department:{...cases.department,access:'read'}},item,status)).toBe(false);
  expect(canRequestDepartmentPreparation({...cases,department:{...cases.department,retiredAt:grant.createdAt}},item,status)).toBe(false);
  expect(canRequestDepartmentPreparation(cases,item,{...status,member:undefined})).toBe(false);
 });
 it('restores exact preparation and owner approval intent while rejecting unrelated credentials',()=>{
  const op={departmentId:prepare.departmentId,kind:'prepare',input:prepare};expect(isDepartmentPreparationOperation(JSON.parse(JSON.stringify(op)))).toBe(true);
  expect(isDepartmentPreparationOperation({...op,departmentId:id(99)})).toBe(false);
  expect(isDepartmentPreparationOperation({...op,input:{...prepare,memberToken:token}})).toBe(false);
  const confirm={departmentId:prepare.departmentId,kind:'confirm',input:{version:1,requestId:id(9),grantId:grant.id,expectedRevision:'0',grantDigest:digest}};
  expect(isDepartmentPreparationOperation(JSON.parse(JSON.stringify(confirm)))).toBe(true);
  expect(isDepartmentPreparationOperation({...confirm,input:{...confirm.input,grantDigest:'short'}})).toBe(false);
 });
 it('renders the full reviewed plan and outputs literally, including text beyond short preview limits',()=>{
  const instructions='Full instruction line.\n'.repeat(200)+'<script>do not execute</script>\nFINAL INSTRUCTION';
  const html=renderToStaticMarkup(createElement(DepartmentPreparationReview,{review:{...review,instructions}}));
  expect(html).toContain('FINAL INSTRUCTION');expect(html).toContain('&lt;script&gt;do not execute&lt;/script&gt;');expect(html).not.toContain('<script>');
  expect(html).toContain('No connected account or website access is included');expect(html).toContain('Complete worker instructions');
  const result=renderToStaticMarkup(createElement(DepartmentPreparationResult,{state:{...local,phase:'review-required',result:{status:'prepared',detail:'A factual result',outputs:['Draft line\n'.repeat(200)+'<img src=x onerror=alert(1)>\nFINAL OUTPUT']}}}));
  expect(result).toContain('FINAL OUTPUT');expect(result).toContain('&lt;img');expect(result).not.toContain('<img');expect(result).toContain('The case stays under human review');
 });
});
