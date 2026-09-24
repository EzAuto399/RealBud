import { describe, it, expect } from 'vitest';
import { encodeCompanyPortalTarget, decodeCompanyPortalTarget, isCompanyPortalBinding, isCompanyPortalBindingPage, isCompanyPortalOperation } from './company-portal-code';
import type { CompanyPortalTarget, CompanyPortalBinding } from '../../shared/company-portal';
const uuid = (n:number) => `11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const target: CompanyPortalTarget = {version:1,purpose:'member-map',companyId:uuid(1),authorityId:uuid(2),certificateDigest:'a'.repeat(64),bindingId:uuid(3),memberId:uuid(4),challengeHash:'b'.repeat(64),expiresAt:'2026-09-22T12:10:00.000Z'};
const row: CompanyPortalBinding = {id:target.bindingId,memberId:target.memberId,memberName:'Fictional member',revision:'0',phase:'pending',current:true,person:null,mapTarget:target,confirmTarget:{...target,purpose:'member-confirm',challengeHash:'c'.repeat(64)},createdAt:'2026-09-22T12:00:00.000Z',confirmedAt:null,revokedAt:null};
describe('attended company portal boundary',()=>{
 it('round trips canonical public targets irrespective of source property order',()=>{
  const encoded=encodeCompanyPortalTarget(target);
  expect(decodeCompanyPortalTarget(encoded)).toEqual(target);
  expect(encodeCompanyPortalTarget(Object.fromEntries(Object.entries(target).reverse()) as CompanyPortalTarget)).toBe(encoded);
 });
 it('rejects added private identity, ambiguous JSON, invalid purpose and oversized code',()=>{
  for(const value of [{...target,providerSubject:uuid(8)},{...target,purpose:'execute'},{...target,certificateDigest:'broken'}]) {
   const code='rbcp1.'+btoa(JSON.stringify(value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
   expect(()=>decodeCompanyPortalTarget(code)).toThrow();
  }
  expect(()=>decodeCompanyPortalTarget(encodeCompanyPortalTarget(target)+'=')).toThrow();
  expect(()=>decodeCompanyPortalTarget('rbcp1.'+'a'.repeat(4096))).toThrow();
  expect(()=>decodeCompanyPortalTarget('https://other.example/'+encodeCompanyPortalTarget(target))).toThrow();
 });
 it('rejects cross-member, cross-host and wrong-purpose binding responses',()=>{
  expect(isCompanyPortalBinding(row)).toBe(true);
  for(const patch of [{memberId:uuid(9)},{certificateDigest:'d'.repeat(64)},{authorityId:uuid(9)},{purpose:'member-map'},{challengeHash:target.challengeHash}])
   expect(isCompanyPortalBinding({...row,confirmTarget:{...row.confirmTarget,...patch}})).toBe(false);
  expect(isCompanyPortalBinding({...row,person:{providerSubject:uuid(9)}})).toBe(false);
  expect(isCompanyPortalBinding({...row,phase:'confirmed',confirmedAt:row.createdAt})).toBe(false);
  expect(isCompanyPortalBinding({...row,phase:'revoked',revokedAt:row.createdAt,current:true})).toBe(false);
 });
 it('bounds pages and disallows duplicate bindings and role coercion',()=>{
  const page={bindings:[row],offset:20,hasMore:false,canManage:true};
  expect(isCompanyPortalBindingPage(page,20,20)).toBe(true);
  expect(isCompanyPortalBindingPage({...page,bindings:[row,row]},20,20)).toBe(false);
  expect(isCompanyPortalBindingPage({...page,canManage:'true'},20,20)).toBe(false);
  expect(isCompanyPortalBindingPage(page,0,20)).toBe(false);
  expect(isCompanyPortalBindingPage(page,20,0)).toBe(false);
 });
 it('restores exact operation UUID, revision and handle while excluding other credentials',()=>{
  const op={action:'accept',body:{version:1,bindingId:row.id,requestId:uuid(7),expectedRevision:'1',proofHandle:'e'.repeat(64)}};
  expect(isCompanyPortalOperation(JSON.parse(JSON.stringify(op)))).toBe(true);
  expect(isCompanyPortalOperation({...op,body:{...op.body,memberToken:'private'}})).toBe(false);
  expect(isCompanyPortalOperation({...op,body:{...op.body,expectedRevision:1}})).toBe(false);
  expect(isCompanyPortalOperation({...op,body:{...op.body,proofHandle:'partial'}})).toBe(false);
 });
});
