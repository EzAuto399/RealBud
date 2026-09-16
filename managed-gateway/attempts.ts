import { createHash } from 'node:crypto';
import { canonical, id, integer, nano, requireThat, type ExecutionGrant } from './contracts.ts';

export function callId(grant:ExecutionGrant) {
  if(grant.schema===1) return 'legacy';
  id(grant.modelCallId); requireThat(grant.modelCallId!=='legacy','reserved_call_id'); return grant.modelCallId;
}
/** No prompt or plain request digest is retained. The keyed request fingerprint binds content. */
export function callAuthorization(grant:ExecutionGrant,kid:string) {
  const {jti:_jti,iat:_iat,exp:_exp,requestDigest:_requestDigest,...stable}=grant;
  return createHash('sha256').update(canonical({kid,...stable})).digest('hex');
}
export function parentEnvelope(grant:ExecutionGrant,kid:string,now:number) {
  requireThat(grant.schema===2 && grant.grantVersion===2,'invalid_parent_version');
  id(grant.provider); id(grant.modelCallId); nano(grant.maxAttemptSpendNanoAud);
  integer(grant.attemptExpiresAt,Number.MAX_SAFE_INTEGER);
  requireThat(grant.exp<=grant.attemptExpiresAt && now<grant.exp && now<grant.attemptExpiresAt,'parent_deadline_exceeded',403);
  requireThat(Array.isArray(grant.allowedModels) && grant.allowedModels.some(e=>e.provider===grant.provider && e.model===grant.model),'model_scope_denied',403);
  const {companyId,memberId,hostInstallationId,deviceId,licenseId,jobId,attemptId,revision,authorityVersion,account,resource,maxAttemptSpendNanoAud,attemptExpiresAt,allowedModels}=grant;
  return {schema:2,kid,companyId,memberId,hostInstallationId,deviceId,licenseId,jobId,attemptId,revision,authorityVersion,account,resource,maxAttemptSpendNanoAud,attemptExpiresAt,allowedModels};
}
