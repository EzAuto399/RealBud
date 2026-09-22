/** Exact protocol-2 work contracts. Enrollment is not a work decision. */
import { COMMAND_PHASES, COMMAND_OUTCOMES, commandUuid, commandDigest, commandLabel, canonicalWebsiteCommand, isWebsiteCommandDescriptor, type WebsiteCommandDescriptor, type WebsiteCommandPhase, type WebsiteCommandOutcome } from './website-commands.ts';
import { remoteExact, remoteIso, isRemoteApproverPerson, isRemoteCommandGrant, type RemoteApproverPerson, type RemoteCommandGrant } from './website-remote-approvers.ts';
import { isRemoteDisclosureTemplate, type RemoteDisclosureTemplate } from './website-remote-disclosure.ts';
export const REMOTE_WORK_PAGE_SIZE=32;
export const REMOTE_WORK_BODY_BYTES=128_000;
export const REMOTE_WORK_MAX_MS=86_400_000;
export const REMOTE_WORK_RETAIN_MS=7*86_400_000;
export type RemoteWorkAudience={enrollmentId:string;generation:1;person:RemoteApproverPerson};
export type RemoteWorkEnvelope={protocol:2;id:string;companyId:string;installationId:string;workspaceId:string;workerBinding:string;grantId:string;generation:number;descriptor:WebsiteCommandDescriptor;requester:RemoteApproverPerson;requesterEnrollmentId:string;createdAt:string;expiresAt:string};
export type RemoteWorkSubmit={protocol:2;requestId:string;grantId:string;generation:number;descriptorId:string;descriptorRevision:string;enrollmentId:string};
export type RemoteWorkTarget={protocol:2;grantId:string;generation:number};
export type RemoteWorkPoll=RemoteWorkTarget&{cursor:number};
export type RemoteWorkAccountInput={protocol:2;cursor:number};
export type RemoteWorkRead={protocol:2;requestId:string;reviewId:string};
export type RemoteWorkReview={protocol:2;reviewId:string;requestId:string;grantId:string;generation:number;activationId:string;previewDigest:string;previewRevision:number;descriptorId:string;descriptorRevision:string;template:RemoteDisclosureTemplate;templateDigest:string;audience:RemoteWorkAudience[];createdAt:string;expiresAt:string};
export type RemoteWorkPublish=RemoteWorkTarget&{requestId:string;expectedRevision:number;review:RemoteWorkReview;reviewDigest:string};
export type RemoteWorkDecide={protocol:2;requestId:string;reviewId:string;reviewDigest:string;expectedReviewRevision:number;decisionId:string;choice:'approve'|'reject'};
export type RemoteWorkDecision={protocol:2;requestId:string;reviewId:string;reviewDigest:string;decisionId:string;choice:'approve'|'reject';reviewRevision:number;person:RemoteApproverPerson;enrollmentId:string;decidedAt:string};
export type RemoteWorkReviewSummary={id:string;digest:string;revision:number;expiresAt:string;decision:RemoteWorkDecision|null;prunedAt:string|null};
export type RemoteWorkState={envelope:RemoteWorkEnvelope;revision:number;phase:WebsiteCommandPhase;cancellationRequested:boolean;runReference:string|null;outcome:WebsiteCommandOutcome|null;updatedAt:string;sequence:number;review:RemoteWorkReviewSummary|null};
export type RemoteWorkPollResult={grant:RemoteCommandGrant;requests:RemoteWorkState[];cursor:number;hasMore:boolean;serverTime:string};
export type RemoteWorkCatalog={grantId:string;generation:number;installationId:string;workspaceId:string;workerBinding:string;workspaceLabel:string;installationLabel:string;descriptors:WebsiteCommandDescriptor[];enrollmentId:string};
export type RemoteWorkAccountResult={catalog:RemoteWorkCatalog[];requests:RemoteWorkState[];cursor:number;hasMore:boolean;serverTime:string};
export type RemoteWorkReviewResult={request:RemoteWorkState;review:RemoteWorkReview|null;serverTime:string};
export type RemoteWorkClaim=RemoteWorkTarget&{requestId:string;expectedRevision:number;claimId:string;reviewId:string;reviewDigest:string;decisionId:string;previewDigest:string;activationId:string};
export type RemoteWorkClaimResult={request:RemoteWorkState;claimId:string;reviewId:string;reviewDigest:string;decisionId:string;previewDigest:string;activationId:string;validUntil:string;serverTime:string};
export type RemoteWorkEvent=RemoteWorkTarget&{requestId:string;eventId:string;expectedRevision:number;phase:WebsiteCommandPhase;outcome:WebsiteCommandOutcome|null;runReference:string|null};
export type RemoteWorkCancel={protocol:2;requestId:string;cancelId:string;expectedRevision:number};
export type RemoteWorkDesktopCancel=RemoteWorkCancel&{grantId:string;generation:number};
export type RemoteWorkPruneResult={pruned:number;serverTime:string};
const uuid=(v:unknown):v is string=>typeof v==='string'&&commandUuid.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&commandDigest.test(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const cursor=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const same=(a:unknown,b:unknown)=>canonicalWebsiteCommand(a)===canonicalWebsiteCommand(b);
const window=(a:unknown,b:unknown)=>remoteIso(a)&&remoteIso(b)&&b>a&&Date.parse(b)-Date.parse(a)<=REMOTE_WORK_MAX_MS;
const target=(v:Record<string,unknown>)=>v.protocol===2&&uuid(v.grantId)&&positive(v.generation);
const phase=(v:unknown)=>typeof v==='string'&&COMMAND_PHASES.includes(v as WebsiteCommandPhase);
const outcome=(v:unknown)=>v===null||typeof v==='string'&&COMMAND_OUTCOMES.includes(v as WebsiteCommandOutcome);
const descriptors=(v:unknown):v is WebsiteCommandDescriptor[]=>Array.isArray(v)&&v.length>0&&v.length<=16&&v.every(isWebsiteCommandDescriptor)&&new Set(v.map(d=>d.id)).size===v.length;
export function isRemoteWorkTarget(v:unknown):v is RemoteWorkTarget{return remoteExact(v,['protocol','grantId','generation'])&&target(v);}
export function isRemoteWorkAudience(v:unknown):v is RemoteWorkAudience{return remoteExact(v,['enrollmentId','generation','person'])&&uuid(v.enrollmentId)&&v.generation===1&&isRemoteApproverPerson(v.person);}
export function isRemoteWorkEnvelope(v:unknown):v is RemoteWorkEnvelope{return remoteExact(v,['protocol','id','companyId','installationId','workspaceId','workerBinding','grantId','generation','descriptor','requester','requesterEnrollmentId','createdAt','expiresAt'])&&target(v)&&uuid(v.id)&&commandLabel(v.companyId,200)&&uuid(v.installationId)&&uuid(v.workspaceId)&&uuid(v.workerBinding)&&isWebsiteCommandDescriptor(v.descriptor)&&isRemoteApproverPerson(v.requester)&&v.requester.companyId===v.companyId&&uuid(v.requesterEnrollmentId)&&window(v.createdAt,v.expiresAt);}
export function isRemoteWorkSubmit(v:unknown):v is RemoteWorkSubmit{return remoteExact(v,['protocol','requestId','grantId','generation','descriptorId','descriptorRevision','enrollmentId'])&&target(v)&&uuid(v.requestId)&&uuid(v.descriptorId)&&digest(v.descriptorRevision)&&uuid(v.enrollmentId);}
export function isRemoteWorkPoll(v:unknown):v is RemoteWorkPoll{return remoteExact(v,['protocol','grantId','generation','cursor'])&&target(v)&&cursor(v.cursor);}
export function isRemoteWorkAccountInput(v:unknown):v is RemoteWorkAccountInput{return remoteExact(v,['protocol','cursor'])&&v.protocol===2&&cursor(v.cursor);}
export function isRemoteWorkRead(v:unknown):v is RemoteWorkRead{return remoteExact(v,['protocol','requestId','reviewId'])&&v.protocol===2&&uuid(v.requestId)&&uuid(v.reviewId);}
const audience=(v:unknown):v is RemoteWorkAudience[]=>Array.isArray(v)&&v.length>0&&v.length<=64&&v.every(isRemoteWorkAudience)&&v.every((a,i)=>i===0||v[i-1].enrollmentId<a.enrollmentId)&&new Set(v.map(a=>a.person.subject)).size===v.length&&new Set(v.map(a=>a.person.companyId)).size===1;
export function isRemoteWorkReview(v:unknown):v is RemoteWorkReview {
 return remoteExact(v,['protocol','reviewId','requestId','grantId','generation','activationId','previewDigest','previewRevision','descriptorId','descriptorRevision','template','templateDigest','audience','createdAt','expiresAt'])&&target(v)&&uuid(v.reviewId)&&uuid(v.requestId)&&uuid(v.activationId)&&digest(v.previewDigest)&&positive(v.previewRevision)&&uuid(v.descriptorId)&&digest(v.descriptorRevision)&&isRemoteDisclosureTemplate(v.template)&&v.template.descriptor.id===v.descriptorId&&v.template.descriptor.revision===v.descriptorRevision&&digest(v.templateDigest)&&audience(v.audience)&&window(v.createdAt,v.expiresAt)&&new TextEncoder().encode(JSON.stringify(v)).byteLength<=120_000;
}
export function isRemoteWorkPublish(v:unknown):v is RemoteWorkPublish{return remoteExact(v,['protocol','grantId','generation','requestId','expectedRevision','review','reviewDigest'])&&target(v)&&uuid(v.requestId)&&positive(v.expectedRevision)&&isRemoteWorkReview(v.review)&&v.review.requestId===v.requestId&&v.review.grantId===v.grantId&&v.review.generation===v.generation&&digest(v.reviewDigest)&&new TextEncoder().encode(JSON.stringify(v)).byteLength<=REMOTE_WORK_BODY_BYTES;}
export function isRemoteWorkDecide(v:unknown):v is RemoteWorkDecide{return remoteExact(v,['protocol','requestId','reviewId','reviewDigest','expectedReviewRevision','decisionId','choice'])&&v.protocol===2&&uuid(v.requestId)&&uuid(v.reviewId)&&digest(v.reviewDigest)&&positive(v.expectedReviewRevision)&&uuid(v.decisionId)&&(v.choice==='approve'||v.choice==='reject');}
export function isRemoteWorkDecision(v:unknown):v is RemoteWorkDecision{return remoteExact(v,['protocol','requestId','reviewId','reviewDigest','decisionId','choice','reviewRevision','person','enrollmentId','decidedAt'])&&v.protocol===2&&uuid(v.requestId)&&uuid(v.reviewId)&&digest(v.reviewDigest)&&uuid(v.decisionId)&&(v.choice==='approve'||v.choice==='reject')&&v.reviewRevision===2&&isRemoteApproverPerson(v.person)&&uuid(v.enrollmentId)&&remoteIso(v.decidedAt);}
export function isRemoteWorkReviewSummary(v:unknown):v is RemoteWorkReviewSummary {
 return remoteExact(v,['id','digest','revision','expiresAt','decision','prunedAt'])&&uuid(v.id)&&digest(v.digest)&&(v.revision===1||v.revision===2)&&remoteIso(v.expiresAt)&&(v.prunedAt===null||remoteIso(v.prunedAt))&&(v.decision===null?v.revision===1:isRemoteWorkDecision(v.decision)&&v.decision.reviewId===v.id&&v.decision.reviewDigest===v.digest&&v.decision.reviewRevision===v.revision);
}
export function isRemoteWorkState(v:unknown):v is RemoteWorkState{return remoteExact(v,['envelope','revision','phase','cancellationRequested','runReference','outcome','updatedAt','sequence','review'])&&isRemoteWorkEnvelope(v.envelope)&&positive(v.revision)&&phase(v.phase)&&typeof v.cancellationRequested==='boolean'&&(v.runReference===null||uuid(v.runReference))&&outcome(v.outcome)&&remoteIso(v.updatedAt)&&cursor(v.sequence)&&(v.review===null||isRemoteWorkReviewSummary(v.review)&&(!v.review.decision||v.review.decision.requestId===v.envelope.id&&v.review.decision.person.companyId===v.envelope.companyId));}
const requests=(v:unknown):v is RemoteWorkState[]=>Array.isArray(v)&&v.length<=REMOTE_WORK_PAGE_SIZE&&v.every(isRemoteWorkState)&&new Set(v.map(r=>r.envelope.id)).size===v.length;
export function isRemoteWorkPollResult(v:unknown):v is RemoteWorkPollResult{if(!remoteExact(v,['grant','requests','cursor','hasMore','serverTime'])||!isRemoteCommandGrant(v.grant)||!requests(v.requests)||!cursor(v.cursor)||typeof v.hasMore!=='boolean'||!remoteIso(v.serverTime))return false;const g=v.grant;return v.requests.every(r=>r.envelope.grantId===g.grantId&&r.envelope.generation===g.generation&&r.envelope.companyId===g.companyId&&r.envelope.installationId===g.installationId&&r.envelope.workspaceId===g.workspaceId&&r.envelope.workerBinding===g.workerBinding);}
export function isRemoteWorkCatalog(v:unknown):v is RemoteWorkCatalog{return remoteExact(v,['grantId','generation','installationId','workspaceId','workerBinding','workspaceLabel','installationLabel','descriptors','enrollmentId'])&&uuid(v.grantId)&&positive(v.generation)&&uuid(v.installationId)&&uuid(v.workspaceId)&&uuid(v.workerBinding)&&commandLabel(v.workspaceLabel)&&commandLabel(v.installationLabel)&&descriptors(v.descriptors)&&uuid(v.enrollmentId);}
export function isRemoteWorkAccountResult(v:unknown):v is RemoteWorkAccountResult{return remoteExact(v,['catalog','requests','cursor','hasMore','serverTime'])&&Array.isArray(v.catalog)&&v.catalog.length<=1000&&v.catalog.every(isRemoteWorkCatalog)&&new Set(v.catalog.map(c=>`${c.grantId}:${c.enrollmentId}`)).size===v.catalog.length&&requests(v.requests)&&cursor(v.cursor)&&typeof v.hasMore==='boolean'&&remoteIso(v.serverTime);}
export function isRemoteWorkReviewResult(v:unknown):v is RemoteWorkReviewResult {
  if (!remoteExact(v,['request','review','serverTime']) || !isRemoteWorkState(v.request) || !remoteIso(v.serverTime)) return false;
  const request=v.request;
  if (v.review===null) return !!request.review?.prunedAt;
  if (!isRemoteWorkReview(v.review) || !request.review) return false;
  const review=v.review, decision=request.review.decision;
  return review.requestId===request.envelope.id && review.grantId===request.envelope.grantId && review.generation===request.envelope.generation &&
    review.reviewId===request.review.id && review.expiresAt===request.review.expiresAt && review.expiresAt<=request.envelope.expiresAt &&
    review.audience.every(a=>a.person.companyId===request.envelope.companyId) &&
    (!decision || review.audience.some(a=>a.enrollmentId===decision.enrollmentId && same(a.person,decision.person))) &&
    same(review.template.descriptor,request.envelope.descriptor);
}
export function isRemoteWorkClaim(v:unknown):v is RemoteWorkClaim{return remoteExact(v,['protocol','grantId','generation','requestId','expectedRevision','claimId','reviewId','reviewDigest','decisionId','previewDigest','activationId'])&&target(v)&&uuid(v.requestId)&&positive(v.expectedRevision)&&uuid(v.claimId)&&uuid(v.reviewId)&&digest(v.reviewDigest)&&uuid(v.decisionId)&&digest(v.previewDigest)&&uuid(v.activationId);}
export function isRemoteWorkClaimResult(v:unknown):v is RemoteWorkClaimResult{return remoteExact(v,['request','claimId','reviewId','reviewDigest','decisionId','previewDigest','activationId','validUntil','serverTime'])&&isRemoteWorkState(v.request)&&uuid(v.claimId)&&uuid(v.reviewId)&&digest(v.reviewDigest)&&uuid(v.decisionId)&&digest(v.previewDigest)&&uuid(v.activationId)&&remoteIso(v.validUntil)&&remoteIso(v.serverTime)&&!!v.request.review&&v.request.review.id===v.reviewId&&v.request.review.digest===v.reviewDigest&&v.request.review.decision?.decisionId===v.decisionId&&v.request.review.decision.choice==='approve'&&v.request.phase==='accepted'&&!v.request.cancellationRequested&&v.validUntil>v.serverTime&&Date.parse(v.validUntil)-Date.parse(v.serverTime)<=60_000;}
export function isRemoteWorkEvent(v:unknown):v is RemoteWorkEvent{return remoteExact(v,['protocol','grantId','generation','requestId','eventId','expectedRevision','phase','outcome','runReference'])&&target(v)&&uuid(v.requestId)&&uuid(v.eventId)&&positive(v.expectedRevision)&&phase(v.phase)&&outcome(v.outcome)&&(v.runReference===null||uuid(v.runReference));}
export function isRemoteWorkCancel(v:unknown):v is RemoteWorkCancel{return remoteExact(v,['protocol','requestId','cancelId','expectedRevision'])&&v.protocol===2&&uuid(v.requestId)&&uuid(v.cancelId)&&positive(v.expectedRevision);}
export function isRemoteWorkDesktopCancel(v:unknown):v is RemoteWorkDesktopCancel{return remoteExact(v,['protocol','requestId','cancelId','expectedRevision','grantId','generation'])&&target(v)&&isRemoteWorkCancel({protocol:v.protocol,requestId:v.requestId,cancelId:v.cancelId,expectedRevision:v.expectedRevision});}
export function isRemoteWorkPruneResult(v:unknown):v is RemoteWorkPruneResult{return remoteExact(v,['pruned','serverTime'])&&cursor(v.pruned)&&remoteIso(v.serverTime);}
