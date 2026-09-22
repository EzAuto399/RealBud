import { randomUUID,createHash } from 'node:crypto';
import { it,expect } from 'vitest';
import { canonicalWebsiteCommand } from '../shared/website-commands.ts';
import { isWebsiteCommandEnvelope } from '../shared/website-commands.ts';
import { isRemoteWorkEnvelope,isRemoteWorkReview,isRemoteWorkPublish,isRemoteWorkReviewResult,isRemoteWorkClaimResult,isRemoteWorkPollResult,isRemoteWorkDecide,isRemoteWorkState,type RemoteWorkReview,type RemoteWorkEnvelope,type RemoteWorkState } from '../shared/website-remote-work.ts';
const digest=(v:unknown)=>createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
function fixture(){
 const ids=Array.from({length:12},()=>randomUUID()),at='2026-09-22T00:00:00.000Z',expiresAt='2026-09-23T00:00:00.000Z';
 const person={subject:ids[0],identityEpoch:1,email:'staff@example.test',agencyLabel:'Fictional agency',companyId:'agency-a'};
 const descriptor={id:ids[1],revision:'a'.repeat(64),operation:'prepare-recipe' as const,label:'Briefing'};
 const envelope:RemoteWorkEnvelope={protocol:2,id:ids[2],grantId:ids[3],generation:1,installationId:ids[4],workspaceId:ids[5],workerBinding:ids[6],companyId:person.companyId,descriptor,requester:person,requesterEnrollmentId:ids[7],createdAt:at,expiresAt};
 const template={version:1 as const,policy:'exact-reviewed-template-v1' as const,descriptor,mailboxAlias:null,sections:[{label:'Full instructions',value:'Prepare the reviewed fictional briefing.'}]};
 const review:RemoteWorkReview={protocol:2,reviewId:ids[8],requestId:envelope.id,grantId:envelope.grantId,generation:1,activationId:ids[9],previewDigest:'b'.repeat(64),previewRevision:1,descriptorId:descriptor.id,descriptorRevision:descriptor.revision,template,templateDigest:digest(template),audience:[{enrollmentId:ids[7],generation:1,person}],createdAt:at,expiresAt};
 const state:RemoteWorkState={envelope,revision:2,phase:'delivered',cancellationRequested:false,runReference:null,outcome:null,sequence:2,updatedAt:at,review:{id:review.reviewId,digest:digest(review),revision:1,expiresAt,decision:null,prunedAt:null}};
 const decision={protocol:2 as const,requestId:envelope.id,reviewId:review.reviewId,reviewDigest:digest(review),decisionId:ids[10],choice:'approve' as const,reviewRevision:2,person,enrollmentId:ids[7],decidedAt:at};
 const accepted={...state,phase:'accepted' as const,review:{...state.review!,revision:2,decision}};
 const claim={request:accepted,claimId:ids[11],reviewId:review.reviewId,reviewDigest:digest(review),decisionId:decision.decisionId,previewDigest:review.previewDigest,activationId:review.activationId,validUntil:'2026-09-22T00:01:00.000Z',serverTime:at};
 return {envelope,review,state,claim,person,descriptor,at,decision};
}
it('keeps protocol2 person-authorized work separate from legacy email-only envelopes',()=>{
 const f=fixture();expect(isRemoteWorkEnvelope(f.envelope)).toBe(true);expect(isWebsiteCommandEnvelope(f.envelope)).toBe(false);expect(isRemoteWorkEnvelope({...f.envelope,protocol:1})).toBe(false);expect(isRemoteWorkEnvelope({...f.envelope,requester:'staff@example.test'})).toBe(false);expect(isRemoteWorkEnvelope({...f.envelope,requester:{...f.person,companyId:'other-agency'}})).toBe(false);
});
it('accepts complete bounded text but rejects private execution binding and duplicate/cross-agency audiences',()=>{
 const {review}=fixture();expect(isRemoteWorkReview(review)).toBe(true);expect(isRemoteWorkReview({...review,binding:{token:'private'}})).toBe(false);expect(isRemoteWorkReview({...review,template:{...review.template,rawAccountId:'private'}})).toBe(false);expect(isRemoteWorkReview({...review,audience:[...review.audience,...review.audience]})).toBe(false);
 const other={...review.audience[0],enrollmentId:randomUUID(),person:{...review.audience[0].person,subject:randomUUID(),companyId:'agency-b'}};expect(isRemoteWorkReview({...review,audience:[...review.audience,other].sort((a,b)=>a.enrollmentId.localeCompare(b.enrollmentId))})).toBe(false);
});
it('rejects malformed expiry and UTF8 oversize without truncating the reviewed plan',()=>{
 const {review}=fixture();expect(isRemoteWorkReview({...review,expiresAt:'2026-09-24T00:00:00.000Z'})).toBe(false);expect(isRemoteWorkReview({...review,expiresAt:'2026-02-30T00:00:00.000Z'})).toBe(false);const sections=Array.from({length:8},()=>({label:'Instructions',value:'房'.repeat(8000)}));expect(isRemoteWorkReview({...review,template:{...review.template,sections}})).toBe(false);
});
it('binds review publication and read receipts to the exact request and template',()=>{
 const f=fixture(),body={protocol:2,grantId:f.envelope.grantId,generation:1,requestId:f.envelope.id,expectedRevision:1,review:f.review,reviewDigest:digest(f.review)};expect(isRemoteWorkPublish(body)).toBe(true);expect(isRemoteWorkPublish({...body,requestId:randomUUID()})).toBe(false);
 const result={request:f.state,review:f.review,serverTime:f.at};expect(isRemoteWorkReviewResult(result)).toBe(true);expect(isRemoteWorkReviewResult({...result,review:{...f.review,template:{...f.review.template,descriptor:{...f.descriptor,label:'Another plan'}}}})).toBe(false);expect(isRemoteWorkReviewResult({...result,review:{...f.review,audience:f.review.audience.map(a=>({...a,person:{...a.person,companyId:'other-agency'}}))}})).toBe(false);expect(isRemoteWorkReviewResult({...result,request:{...f.state,envelope:{...f.envelope,expiresAt:'2026-09-22T01:00:00.000Z'}}})).toBe(false);expect(isRemoteWorkReviewResult({...result,request:{...f.state,review:{...f.state.review,revision:2,decision:{...f.decision,enrollmentId:randomUUID()}}}})).toBe(false);expect(isRemoteWorkReviewResult({...result,review:null})).toBe(false);expect(isRemoteWorkReviewResult({...result,review:null,request:{...f.state,review:{...f.state.review,prunedAt:f.at}}})).toBe(true);
});
it('claim receipt must carry the exact winning decision, accepted phase and original bounded lease',()=>{
 const {claim}=fixture();expect(isRemoteWorkClaimResult(claim)).toBe(true);expect(isRemoteWorkClaimResult({...claim,decisionId:randomUUID()})).toBe(false);expect(isRemoteWorkClaimResult({...claim,validUntil:'2026-09-22T00:02:00.000Z'})).toBe(false);expect(isRemoteWorkClaimResult({...claim,request:{...claim.request,phase:'delivered'}})).toBe(false);expect(isRemoteWorkClaimResult({...claim,request:{...claim.request,cancellationRequested:true}})).toBe(false);expect(isRemoteWorkClaimResult({...claim,request:{...claim.request,review:{...claim.request.review,decision:{...claim.request.review.decision,choice:'reject'}}}})).toBe(false);
});
it('poll rejects cross-workspace envelopes even when individual states parse',()=>{
 const f=fixture(),e=f.envelope,grant={protocol:2,grantId:e.grantId,generation:e.generation,installationId:e.installationId,workspaceId:e.workspaceId,workerBinding:e.workerBinding,workspaceLabel:'Fictional workspace',descriptors:[f.descriptor],companyId:e.companyId,enrolledAt:f.at,revokedAt:null};const poll={grant,requests:[f.state],cursor:2,hasMore:false,serverTime:f.at};expect(isRemoteWorkPollResult(poll)).toBe(true);const foreign={...f.state,envelope:{...e,workerBinding:randomUUID()}};expect(isRemoteWorkState(foreign)).toBe(true);expect(isRemoteWorkPollResult({...poll,requests:[foreign]})).toBe(false);
});
it('browser decisions contain exact reviewed identity and no supplied actor or approval flag shortcut',()=>{
 const f=fixture(),body={protocol:2,requestId:f.envelope.id,reviewId:f.review.reviewId,reviewDigest:digest(f.review),expectedReviewRevision:1,decisionId:f.decision.decisionId,choice:'approve'};expect(isRemoteWorkDecide(body)).toBe(true);expect(isRemoteWorkDecide({...body,person:f.person})).toBe(false);expect(isRemoteWorkDecide({...body,choice:true})).toBe(false);expect(isRemoteWorkDecide({...body,expectedReviewRevision:0})).toBe(false);
});
