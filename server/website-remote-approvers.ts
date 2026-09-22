/** Attended enrollment only. This module cannot read sources or dispatch workers. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { createWebsiteRequestsTransport } from './website-requests-transport.ts';
import { canonicalWebsiteCommand, commandDigest, commandLabel, commandUuid, type WebsiteCommandDescriptor } from '../shared/website-commands.ts';
import {
  REMOTE_APPROVER_MS, REMOTE_CHALLENGE_MS, REMOTE_DISCLOSURE_POLICY, REMOTE_ENROLLMENT_LIMIT,
  isRemoteApproverScope, isRemoteApproverPerson, isRemoteApproverGrant, remoteIso, isRemoteCommandEnrollment, isRemoteCommandGrant, isRemoteEnrollmentBegin,
  isRemoteEnrollmentConfirm, isRemoteEnrollmentSnapshot, remoteExact,
  type RemoteApproverScope, type RemoteCommandEnrollment, type RemoteCommandGrant,
  type RemoteEnrollmentBegin, type RemoteEnrollmentConfirm, type RemoteEnrollmentSnapshot, type RemoteApproverGrant,
} from '../shared/website-remote-approvers.ts';
import type { OfficeLinkCredentials } from './office-link.ts';
import type { WebsiteRequestIdentity } from './website-requests.ts';

export type RemoteModeMarker = {version:2;mode:'remote-approvers';transitionId:string;generation:number};
export const REMOTE_STATE_FILE = 'remote-approvers.json';
function fail(message = 'Remote approver enrollment needs recovery. No work was started.', status = 409): never {throw Object.assign(new Error(message),{status});}
const same = (a:unknown,b:unknown) => canonicalWebsiteCommand(a)===canonicalWebsiteCommand(b);
const digest = (value:unknown) => createHash('sha256').update(canonicalWebsiteCommand(value)).digest('hex');
const inactivePhase = (phase:unknown) => phase==='revoked'||phase==='expired'||phase==='stale';
const hashSecret = (value:string) => createHash('sha256').update(value).digest('hex');
const positive = (v:unknown) => Number.isSafeInteger(v) && Number(v)>0 && Number(v)<2147483647;
export function isRemoteModeMarker(v:unknown): v is RemoteModeMarker {
  return remoteExact(v,['version','mode','transitionId','generation']) && v.version===2 && v.mode==='remote-approvers' && typeof v.transitionId==='string' && commandUuid.test(v.transitionId) && positive(v.generation);
}
type SavedEnrollment = {revision:number;begin:RemoteEnrollmentBegin;secret:string;confirmation:RemoteEnrollmentConfirm|null;snapshot:RemoteEnrollmentSnapshot|null;revoking:boolean;revoked:boolean};
type SavedRemote = {version:2;history:RemoteEnrollmentView[];previous:{marker:RemoteModeMarker;grant:RemoteCommandGrant}|null;marker:RemoteModeMarker;identity:WebsiteRequestIdentity;authority:string;companyId:string;parent:RemoteCommandEnrollment;grant:RemoteCommandGrant|null;scopes:RemoteApproverScope[];enabled:boolean;revoked:boolean;enrollments:SavedEnrollment[]};
export type RemotePrepareInput = {descriptorIds:string[];label:string;scopes:RemoteApproverScope[]};
export type RemoteEnrollmentView = {id:string;revision:number;phase:string;candidate:RemoteEnrollmentSnapshot['candidate'];candidateDigest:string|null;scopes:RemoteApproverScope[];expiresAt:string;approverExpiresAt:string;approver:RemoteEnrollmentSnapshot['approver']};
export type RemoteApproversStatus = {remoteMode:boolean;enabled:boolean;pending:boolean;linked:boolean;workspaceId:string;workspaceLabel:string|null;grant:RemoteCommandGrant|null;scopes:RemoteApproverScope[];enrollments:RemoteEnrollmentView[];error:string|null;busy:boolean};
/** Server-only capability; never serialize this object into an HTTP response. */
export type RemoteWorkAuthority = {
  parent:RemoteCommandGrant; commandToken:string; identity:WebsiteRequestIdentity;
  authority:string; scopes:RemoteApproverScope[]; approvers:RemoteApproverGrant[];
  assertCurrent():Promise<void>; isCurrent():boolean;
};
export interface RemoteApproversOptions {
  directory:string; officeLink:{credentials():Promise<OfficeLinkCredentials|null>};identity():WebsiteRequestIdentity;
  authority():string; revisionEpoch():number; getCatalog():Promise<WebsiteCommandDescriptor[]>;
  onRemoteEvidence?(value:{enrollmentId:string;workspaceId:string;snapshot:RemoteEnrollmentSnapshot|null;scopes:RemoteApproverScope[];phase:string}):void|Promise<void>;
  requireRemoteScopes?(scopes:RemoteApproverScope[]):Promise<void>;
  barrier?():void; exclusive<T>(work:()=>Promise<T>, wait?:boolean):Promise<T>;
  prepareMarker(persist:(generation:number)=>Promise<RemoteModeMarker>):Promise<void>;
  ensureMarker(marker:RemoteModeMarker,previous?:RemoteModeMarker|null):Promise<void>;
  fetch?:typeof fetch;now?:()=>number;
}
function parentMatches(s:SavedRemote,g:RemoteCommandGrant) {
  const {commandToken:_token,...spec}=s.parent;
  const {companyId,enrolledAt:_at,revokedAt:_revoked,...received}=g;
  return companyId===s.companyId && same(spec,received);
}
function validate(value:unknown):SavedRemote {
  if (!remoteExact(value,['version','history','previous','marker','identity','authority','companyId','parent','grant','scopes','enabled','revoked','enrollments']) || value.version!==2 || !isRemoteModeMarker(value.marker) || !remoteExact(value.identity,['workspaceId','workerProfileKey']) || typeof value.identity.workspaceId!=='string' || !commandUuid.test(value.identity.workspaceId) || !(value.identity.workerProfileKey===null || typeof value.identity.workerProfileKey==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.identity.workerProfileKey)) || typeof value.authority!=='string' || !commandDigest.test(value.authority) || !commandLabel(value.companyId,200) || !isRemoteCommandEnrollment(value.parent) || value.parent.workspaceId!==value.identity.workspaceId || value.parent.generation!==value.marker.generation || !(value.grant===null || isRemoteCommandGrant(value.grant)) || typeof value.enabled!=='boolean' || typeof value.revoked!=='boolean' || value.revoked && value.enabled || !Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length>16 || !value.scopes.every(isRemoteApproverScope) || new Set(value.scopes.map(s=>s.descriptorId)).size!==value.scopes.length || !Array.isArray(value.enrollments) || value.enrollments.length>REMOTE_ENROLLMENT_LIMIT) return fail(undefined,503);
  const s=value as SavedRemote;
  if(Buffer.byteLength(JSON.stringify(s))>2_000_000||!Array.isArray(s.history)||s.history.length+s.enrollments.length>REMOTE_ENROLLMENT_LIMIT||s.history.some(e=>!remoteExact(e,['id','revision','phase','candidate','candidateDigest','scopes','expiresAt','approverExpiresAt','approver'])||typeof e.id!=='string'||!commandUuid.test(e.id)||!positive(e.revision)||!['disabled','revoked','expired','stale'].includes(e.phase)||!(e.candidate===null||isRemoteApproverPerson(e.candidate))||!(e.candidateDigest===null||typeof e.candidateDigest==='string'&&commandDigest.test(e.candidateDigest))||!Array.isArray(e.scopes)||!e.scopes.length||e.scopes.length>16||!e.scopes.every(isRemoteApproverScope)||!remoteIso(e.expiresAt)||!remoteIso(e.approverExpiresAt)||!(e.approver===null||isRemoteApproverGrant(e.approver))))return fail(undefined,503);
  if(s.previous!==null&&(!remoteExact(s.previous,['marker','grant'])||!isRemoteModeMarker(s.previous.marker)||!isRemoteCommandGrant(s.previous.grant)||!s.previous.grant.revokedAt||s.previous.marker.generation!==s.previous.grant.generation||s.marker.generation!==s.previous.marker.generation+1))return fail(undefined,503);
  if(s.grant&&!parentMatches(s,s.grant) || s.scopes.some(scope=>!s.parent.descriptors.some(d=>d.id===scope.descriptorId&&d.revision===scope.descriptorRevision)))return fail(undefined,503);
  const ids=new Set<string>();
  for(const e of s.enrollments){
    if(!remoteExact(e,['revision','begin','secret','confirmation','snapshot','revoking','revoked']) || !positive(e.revision) || !isRemoteEnrollmentBegin(e.begin) || e.begin.grantId!==s.parent.grantId || e.begin.generation!==s.parent.generation || typeof e.secret!=='string'||!commandDigest.test(e.secret)||hashSecret(e.secret)!==e.begin.challengeHash || !(e.confirmation===null||isRemoteEnrollmentConfirm(e.confirmation)) || !(e.snapshot===null||isRemoteEnrollmentSnapshot(e.snapshot)) || typeof e.revoking!=='boolean'||typeof e.revoked!=='boolean'||e.revoked&&!e.revoking || ids.has(e.begin.enrollmentId) || e.begin.scopes.some(scope=>!s.scopes.some(allowed=>same(allowed,scope))))return fail(undefined,503);
    ids.add(e.begin.enrollmentId);
    if(e.confirmation&&(e.confirmation.enrollmentId!==e.begin.enrollmentId||e.confirmation.grantId!==e.begin.grantId||e.confirmation.generation!==e.begin.generation))return fail(undefined,503);
    if(e.snapshot) assertSnapshot(s,e,e.snapshot);
  }
  return structuredClone(s);
}
function assertSnapshot(s:SavedRemote,e:SavedEnrollment,snapshot:RemoteEnrollmentSnapshot){
  if(!same(snapshot.begin,e.begin)||snapshot.target.workspaceLabel!==s.parent.workspaceLabel||!same(snapshot.target.descriptors,s.parent.descriptors)||snapshot.candidate&&snapshot.candidate.companyId!==s.companyId)return fail('The website returned another enrollment.',502);
  if(snapshot.phase==='confirmed'&&snapshot.approver?.revokedAt)return fail('The approver permission is already revoked.',502);
  const prior=e.snapshot?.approver;
  if(prior){const {revokedAt:_priorRevoked,...before}=prior;const {revokedAt:_nextRevoked,...after}=snapshot.approver??{};if(!snapshot.approver||!same(before,after)||prior.revokedAt&&snapshot.approver.revokedAt!==prior.revokedAt)return fail('The website returned inconsistent approver history.',502);}
  const a=snapshot.approver;
  if(a&&(a.installationId!==s.parent.installationId||a.workspaceId!==s.parent.workspaceId||a.workerBinding!==s.parent.workerBinding||a.companyId!==s.companyId||!e.confirmation||!same(a.person,e.confirmation.candidate)))return fail('The website returned another approver permission.',502);
}
export function createWebsiteRemoteApprovers(options:RemoteApproversOptions){
  const path=join(options.directory,'website-requests',REMOTE_STATE_FILE),transport=createWebsiteRequestsTransport(options.fetch),now=options.now??Date.now;
  let stopped=false,epoch=0,stateVersion=0,error:string|null=null,busy=false;
  async function read(){const v=await readPrivateJson(path,2_000_000);if(v===undefined&&isRemoteModeMarker(await readPrivateJson(join(options.directory,'website-requests','grant.json'),64_000)))return fail(undefined,503);return v===undefined?null:validate(v);}
  async function save(s:SavedRemote){validate(s);stateVersion++;await writePrivateJson(path,s);if(options.onRemoteEvidence)for(const e of s.enrollments)await options.onRemoteEvidence({enrollmentId:e.begin.enrollmentId,workspaceId:s.identity.workspaceId,snapshot:structuredClone(e.snapshot),scopes:structuredClone(e.begin.scopes),phase:view(s,e).phase});}
  const run=<T>(work:()=>Promise<T>,wait=false)=>options.exclusive(async()=>{busy=true;try{options.barrier?.();const result=await work();error=null;return result;}catch(cause){error='Enrollment could not be confirmed. Review its saved status and retry.';throw cause;}finally{busy=false;}},wait);
  function capture(){options.barrier?.();if(stopped)fail('Remote enrollment is stopped.');return {epoch,revision:options.revisionEpoch(),identity:structuredClone(options.identity()),authority:options.authority()};}
  function assertCapture(c:ReturnType<typeof capture>){options.barrier?.();if(stopped||epoch!==c.epoch||options.revisionEpoch()!==c.revision||!same(options.identity(),c.identity)||options.authority()!==c.authority)fail('The workspace or permission changed. Review enrollment again.');}
  // Reading a revocation does not require a runnable source or worker. It still
  // belongs to this exact local workspace/member, marker and website installation.
  function captureRead(){options.barrier?.();if(stopped)fail('Remote enrollment is stopped.');return {epoch,identity:structuredClone(options.identity())};}
  function assertRead(c:ReturnType<typeof captureRead>){options.barrier?.();if(stopped||epoch!==c.epoch||!same(options.identity(),c.identity))fail('The workspace or permission changed. Refresh enrollment status.');}
  async function readable(s:SavedRemote,c:ReturnType<typeof captureRead>){
    assertRead(c);if(!s.enabled||s.revoked||!same(s.identity,c.identity))fail('This enrollment belongs to another workspace permission.');
    const marker=await readPrivateJson(join(options.directory,'website-requests','grant.json'),64_000);assertRead(c);
    if(!isRemoteModeMarker(marker)||!same(marker,s.marker))fail('Remote enrollment transition needs recovery. Sync the saved enrollment.');
    const link=await options.officeLink.credentials();assertRead(c);
    if(!link||link.installationId!==s.parent.installationId||link.companyId!==s.companyId)fail('The website link changed. Restore the matching computer link to refresh this enrollment.');
    const fresh=await read();assertRead(c);
    if(!fresh||!same(fresh,s))fail('Saved enrollment changed. Refresh its status.');
  }
  async function current(s:SavedRemote,c= capture()){
    const marker=await readPrivateJson(join(options.directory,'website-requests','grant.json'),64_000);
    assertCapture(c);if(!isRemoteModeMarker(marker)||!same(marker,s.marker))fail('Remote enrollment transition needs recovery. Sync the saved enrollment.');
    if(!s.enabled||s.revoked||!same(s.identity,c.identity)||s.authority!==c.authority)fail('This enrollment belongs to an inactive workspace permission.');
    const link=await options.officeLink.credentials();assertCapture(c);
    if(!link||link.installationId!==s.parent.installationId||link.companyId!==s.companyId)fail('The website link changed. Disable and enroll this workspace again.');
    const catalog=await options.getCatalog();assertCapture(c);
    if(s.parent.descriptors.some(d=>!catalog.some(current=>same(current,d))))fail('The published work changed. Disable and review it again.');
    if(!options.requireRemoteScopes)fail('Remote disclosure review is not configured.',503);
    await options.requireRemoteScopes(s.scopes);assertCapture(c);
    return link;
  }
  async function workAuthority():Promise<RemoteWorkAuthority>{
    const c=capture(),s=await read();assertCapture(c);
    if(!s?.grant||s.grant.revokedAt)fail('Prepare this workspace for remote work first.');
    await current(s,c);
    const eligible=()=>s.enrollments.filter(e=>!e.revoking&&!e.revoked&&e.snapshot?.phase==='confirmed'&&e.snapshot.approver&&!e.snapshot.approver.revokedAt&&Date.parse(e.snapshot.approver.expiresAt)>now()).map(e=>e.snapshot!.approver!);
    const approvers=eligible();
    if(!approvers.length)fail('Confirm a current remote approver before enabling remote work.');
    const version=stateVersion;
    const isCurrent=()=>{try{assertCapture(c);return stateVersion===version&&approvers.every(a=>Date.parse(a.expiresAt)>now());}catch{return false;}};
    const assertCurrent=async()=>{
      if(!isCurrent())fail('Remote work permission changed. Refresh access.');
      await current(s,c);
      const fresh=await read();assertCapture(c);
      if(!isCurrent()||!fresh||!same(fresh,s))fail('Remote work permission changed. Refresh access.');
    };
    await assertCurrent();
    return {parent:structuredClone(s.grant),commandToken:s.parent.commandToken,identity:structuredClone(s.identity),authority:s.authority,scopes:structuredClone(s.scopes),approvers:structuredClone(approvers),assertCurrent,isCurrent};
  }
  function view(s:SavedRemote,e:SavedEnrollment):RemoteEnrollmentView{
    const snapshot=e.snapshot;
    const phase=!s.enabled?'disabled':e.revoking?(e.revoked?'revoked':'revoking'):inactivePhase(snapshot?.phase)?snapshot!.phase:snapshot?.phase==='confirmed'&&Date.parse(e.begin.approverExpiresAt)<=now()?'expired':snapshot?.phase!=='confirmed'&&Date.parse(e.begin.expiresAt)<=now()?'expired':snapshot?.phase??'publishing';
    return {id:e.begin.enrollmentId,revision:e.revision,phase,candidate:snapshot?.candidate??null,candidateDigest:snapshot?.candidate?digest({begin:e.begin,candidate:snapshot.candidate}):null,scopes:e.begin.scopes,expiresAt:e.begin.expiresAt,approverExpiresAt:e.begin.approverExpiresAt,approver:snapshot?.approver??null};
  }
  async function status():Promise<RemoteApproversStatus>{
    const s=await read(),link=await options.officeLink.credentials();
    const linked=!!link&&(!s||link.installationId===s.parent.installationId&&link.companyId===s.companyId);
    let held=false;
    if(s?.enabled){
      try{const c=capture();await current(s,c);}catch{held=true;}
    }
    const enrollments=s?[...s.enrollments.map(e=>({...view(s,e),...(held&&!e.revoking&&!inactivePhase(e.snapshot?.phase)?{phase:'stale'}:{})})),...s.history]:[];
    return {remoteMode:!!s,enabled:!!s?.enabled&&!stopped&&!held,pending:!!s?.enabled&&!s.grant,linked,workspaceId:options.identity().workspaceId,workspaceLabel:s?.parent.workspaceLabel??null,grant:s?.grant??null,scopes:s?.scopes??[],enrollments,error:held?'Enrollment is on hold. Check this workspace’s sources and settings, then refresh access.':error,busy};
  }

  async function publishParent(s:SavedRemote){
    await options.ensureMarker(s.marker,s.previous?.marker??null);const c=capture(),link=await current(s,c);
    const grant=await transport.post('v2/command-grants',link.token,s.parent,v=>isRemoteCommandGrant(v)?v:fail('Invalid website workspace permission.',502));
    if(!parentMatches(s,grant)||grant.revokedAt)fail('The website returned another workspace permission.',502);
    assertCapture(c);await current(s,c);s.grant=grant;await save(s);assertCapture(c);return s;
  }
  async function prepare(input:RemotePrepareInput){return run(async()=>{
    if(!remoteExact(input,['descriptorIds','label','scopes'])||!commandLabel(input.label)||!Array.isArray(input.descriptorIds)||!input.descriptorIds.length||input.descriptorIds.length>16||new Set(input.descriptorIds).size!==input.descriptorIds.length||!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.length>16||!input.scopes.every(isRemoteApproverScope))fail('Review the workspace and disclosure scopes first.',400);
    const c=capture(),link=await options.officeLink.credentials();assertCapture(c);if(!link)fail('Link this computer to the website first.');
    const catalog=await options.getCatalog();assertCapture(c);
    const descriptors=input.descriptorIds.map(id=>catalog.find(d=>d.id===id)??fail('Selected work is unavailable.'));
    if(input.scopes.some(scope=>!descriptors.some(d=>d.id===scope.descriptorId&&d.revision===scope.descriptorRevision)))fail('Disclosure does not match the selected work.');
    if(!options.requireRemoteScopes)fail('Remote disclosure review is not configured.',503);
    await options.requireRemoteScopes(input.scopes);assertCapture(c);
    let s=await read();
    if(s?.enabled){if(s.parent.workspaceLabel!==input.label||!same(s.parent.descriptors,descriptors)||!same(s.scopes,input.scopes))fail('Retry the saved enrollment or disable it before changing work.');await current(s,c);if(!s.grant)await publishParent(s);return status();}
    if(s&&!s.revoked)await disableSaved(s);
    const previous=s?.grant&&s.revoked?{marker:s.marker,grant:s.grant}:null;
    const history=s?[...s.enrollments.map(e=>({...view(s!,e),phase:'revoked'})),...s.history]:[];
    await options.prepareMarker(async generation=>{
      assertCapture(c);const marker:RemoteModeMarker={version:2,mode:'remote-approvers',transitionId:randomUUID(),generation};
      s={version:2,history,previous,marker,identity:c.identity,authority:c.authority,companyId:link.companyId,parent:{protocol:2,grantId:randomUUID(),generation,installationId:link.installationId,workspaceId:c.identity.workspaceId,workspaceLabel:input.label,workerBinding:randomUUID(),descriptors,commandToken:randomBytes(32).toString('hex')},grant:null,scopes:structuredClone(input.scopes),enabled:true,revoked:false,enrollments:[]};
      await save(s);return marker;
    });
    assertCapture(c);await publishParent(s!);return status();
  });}
  const target=(s:SavedRemote,e:SavedEnrollment)=>({protocol:2 as const,enrollmentId:e.begin.enrollmentId,grantId:s.parent.grantId,generation:s.parent.generation});
  async function publish(s:SavedRemote,e:SavedEnrollment,route:'begin'|'status'|'confirm'|'revoke',c=capture()){
    if(route!=='revoke')await current(s,c);
    const body=route==='begin'?e.begin:route==='confirm'?e.confirmation:target(s,e);
    const snapshot=await transport.post(`v2/remote-approvers/${route}`,s.parent.commandToken,body,v=>isRemoteEnrollmentSnapshot(v)?v:fail('Invalid enrollment receipt.',502));
    assertSnapshot(s,e,snapshot);
    if(route!=='revoke'){assertCapture(c);await current(s,c);}
    if(route==='confirm'&&!inactivePhase(snapshot.phase)&&(snapshot.phase!=='confirmed'||!snapshot.approver))fail('The candidate was not confirmed.');
    if(route==='revoke'&&snapshot.phase!=='revoked')fail('Revocation is not confirmed.');
    const semantic=(value:RemoteEnrollmentSnapshot)=>{const {serverTime:_time,...fields}=value;return fields;};
    if(!e.snapshot||!same(semantic(e.snapshot),semantic(snapshot)))e.revision++;
    e.snapshot=snapshot;if(route==='revoke')e.revoked=true;await save(s);
    if(route!=='revoke')assertCapture(c);
  }
  async function reconcileStatus(s:SavedRemote,e:SavedEnrollment){
    const c=captureRead();await readable(s,c);
    const snapshot=await transport.post('v2/remote-approvers/status',s.parent.commandToken,target(s,e),v=>isRemoteEnrollmentSnapshot(v)?v:fail('Invalid enrollment receipt.',502));
    assertSnapshot(s,e,snapshot);await readable(s,c);
    // Inactive authority is safe to retain under a readiness hold. A candidate or
    // confirmed receipt must pass the complete mutation guard before adoption.
    if(!inactivePhase(snapshot.phase)){
      try{const live=capture();await current(s,live);}catch{return;}
    }
    const semantic=(value:RemoteEnrollmentSnapshot)=>{const {serverTime:_time,...fields}=value;return fields;};
    if(e.snapshot&&same(semantic(e.snapshot),semantic(snapshot)))return;
    e.revision++;e.snapshot=snapshot;await save(s);assertRead(c);
  }
  async function begin(input:{scopes:RemoteApproverScope[]}){return run(async()=>{
    if(!remoteExact(input,['scopes'])||!Array.isArray(input.scopes)||!input.scopes.length||!input.scopes.every(isRemoteApproverScope))fail('Review disclosure scopes first.',400);
    const c=capture(),s=await read();if(!s||!s.grant)fail('Prepare this workspace for remote enrollment first.');await current(s,c);
    if(input.scopes.some(scope=>!s.scopes.some(allowed=>same(allowed,scope))))fail('Disclosure scope has not been reviewed.');
    let e=s.enrollments.find(e=>!e.revoking&&!e.confirmation&&(!e.snapshot||e.snapshot.phase==='pending')&&Date.parse(e.begin.expiresAt)>now()&&same(e.begin.scopes,input.scopes));
    if(!e){
      if(s.enrollments.length+s.history.length>=REMOTE_ENROLLMENT_LIMIT)fail('Enrollment history is full. Contact support before adding people.');
      const started=now();
      const clock=await transport.post('v2/remote-approvers/clock',s.parent.commandToken,{protocol:2,grantId:s.parent.grantId,generation:s.parent.generation},v=>remoteExact(v,['serverTime'])&&remoteIso(v.serverTime)?{serverTime:v.serverTime}:fail('Invalid website clock receipt.',502));
      assertCapture(c);await current(s,c);
      const serverTime=Date.parse(clock.serverTime);
      if(Math.abs(now()-serverTime)>60_000||Math.abs(started-serverTime)>60_000)fail('Check this computer’s date and time, then start enrollment again.');
      const secret=randomBytes(32).toString('hex');e={revision:1,begin:{protocol:2,enrollmentId:randomUUID(),grantId:s.parent.grantId,generation:s.parent.generation,challengeHash:hashSecret(secret),scopes:structuredClone(input.scopes),disclosurePolicy:REMOTE_DISCLOSURE_POLICY,expiresAt:new Date(serverTime+REMOTE_CHALLENGE_MS).toISOString(),approverExpiresAt:new Date(serverTime+REMOTE_APPROVER_MS).toISOString()},secret,confirmation:null,snapshot:null,revoking:false,revoked:false};s.enrollments.push(e);await save(s);}
    if(Date.parse(e.begin.expiresAt)<=now())fail('This challenge expired. Revoke it and start a new enrollment.');
    assertCapture(c);await publish(s,e,'begin',c);return {status:await status(),challenge:{enrollmentId:e.begin.enrollmentId,secret:e.secret,expiresAt:e.begin.expiresAt}};
  });}
  async function syncWithinActivity(id?:string){
    if(id!==undefined&&!commandUuid.test(id))fail('Invalid enrollment.',400);
    const observed=captureRead(),s=await read();assertRead(observed);if(!s)return status();
    await options.ensureMarker(s.marker,s.previous?.marker??null);assertRead(observed);
    if(!s.enabled){if(!s.revoked)await disableSaved(s);return status();}
    if(!s.grant)await publishParent(s);
    const rows=id?[s.enrollments.find(e=>e.begin.enrollmentId===id)??fail('Enrollment not found.',404)]:s.enrollments;
    for(const e of rows){
      if(e.revoked||!e.revoking&&inactivePhase(e.snapshot?.phase))continue;
      assertRead(observed);
      if(e.revoking){await publish(s,e,'revoke');continue;}
      if(e.snapshot?.phase==='confirmed'){await reconcileStatus(s,e);continue;}
      let live:ReturnType<typeof capture>|null=null;
      try{live=capture();await current(s,live);}catch{live=null;}
      if(!live){await reconcileStatus(s,e);continue;}
      await publish(s,e,e.confirmation?'confirm':e.snapshot?'status':'begin',live);
    }
    return status();
  }
  const sync=(id?:string)=>run(()=>syncWithinActivity(id));
  async function confirm(input:{enrollmentId:string;expectedRevision:number;candidateDigest:string}){return run(async()=>{
    if(!remoteExact(input,['enrollmentId','expectedRevision','candidateDigest'])||!commandUuid.test(input.enrollmentId)||!positive(input.expectedRevision)||!commandDigest.test(input.candidateDigest))fail('Review the current candidate first.',400);
    const c=capture(),s=await read();if(!s)fail();const e=s.enrollments.find(e=>e.begin.enrollmentId===input.enrollmentId)??fail('Enrollment not found.',404);
    if(e.revision!==input.expectedRevision||e.revoking||!e.snapshot?.candidate||!['candidate','confirmed'].includes(e.snapshot.phase)||view(s,e).candidateDigest!==input.candidateDigest||Date.parse(e.begin.expiresAt)<=now())fail('The candidate changed or expired. Refresh before confirming.');
    await current(s,c);e.confirmation={...target(s,e),candidate:structuredClone(e.snapshot.candidate)};e.revision++;await save(s);
    assertCapture(c);await publish(s,e,'confirm',c);return status();
  });}
  async function revoke(id:string){epoch++;transport.abort();return run(async()=>{
    if(!commandUuid.test(id))fail('Invalid enrollment.',400);const s=await read();if(!s)fail();const e=s.enrollments.find(e=>e.begin.enrollmentId===id)??fail('Enrollment not found.',404);
    if(!e.revoking){e.revoking=true;e.revision++;await save(s);}if(!e.revoked)await publish(s,e,'revoke');return status();
  },true);}
  async function disableSaved(s:SavedRemote){
    if(s.enabled){s.enabled=false;for(const e of s.enrollments)e.revoking=true;await save(s);}
    if(s.revoked)return;
    const parse=(v:unknown)=>isRemoteCommandGrant(v)?v:fail('Invalid revocation receipt.',502);
    let grant:RemoteCommandGrant;
    if(!s.grant){
      // A missing publication receipt is ambiguous: cancel the exact enrollment
      // with the report authority so the website creates a revoked tombstone.
      // Do not require current work/disclosure approval to remove permission.
      const link=await options.officeLink.credentials();
      options.barrier?.();
      if(!link||link.installationId!==s.parent.installationId||link.companyId!==s.companyId)fail('The website link changed. Restore the original computer link to cancel this pending permission.');
      grant=await transport.post('v2/command-grants/cancel',link.token,s.parent,parse);
    }else{
      grant=await transport.post('v2/command-grants',s.parent.commandToken,{protocol:2,grantId:s.parent.grantId,generation:s.parent.generation},parse,'DELETE');
    }
    if(!parentMatches(s,grant)||!grant.revokedAt)fail('The website did not confirm revocation.',502);
    s.grant=grant;s.revoked=true;for(const e of s.enrollments)e.revoked=true;await save(s);
  }
  async function disable(){epoch++;transport.abort();return run(async()=>{const s=await read();if(s)await disableSaved(s);return status();},true);}
  return {status,prepare,begin,sync,syncWithinActivity,workAuthority,confirm,revoke,disable,stop(){stopped=true;epoch++;transport.abort();},start(){stopped=false;},get busy(){return busy;}};
}
