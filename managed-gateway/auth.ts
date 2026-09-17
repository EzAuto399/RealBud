import { createPublicKey, verify } from 'node:crypto';
import { canonical, exact, id, integer, nano, object, requireThat, type ExecutionGrant, type GrantEnvelope, type ModelRequest } from './contracts.ts';
import { validateMessages } from './messages.ts';
import { digest, UsageLedger } from './ledger.ts';

export function validateRequest(value: unknown): asserts value is ModelRequest {
  object(value); exact(value,['model','rateVersion','idempotencyKey','messages','maxOutputTokens',...(value.protocol==='tools-v1'?['protocol','tools','thinking',...(Object.hasOwn(value,'reasoningEffort')?['reasoningEffort']:[])]:[])]);
  [value.model,value.rateVersion,value.idempotencyKey].forEach(id); integer(value.maxOutputTokens,1_000_000); requireThat(Number(value.maxOutputTokens)>0,'invalid_output_limit');
  requireThat(Array.isArray(value.messages) && value.messages.length>0 && value.messages.length<=256,'invalid_messages');
  validateMessages(value as unknown as ModelRequest);
}
export function verifyGrant(envelope: GrantEnvelope, request: ModelRequest, ledger: UsageLedger): ExecutionGrant {
  object(envelope); exact(envelope as unknown as Record<string,unknown>,['kid','payload','signature']); id(envelope.kid);
  requireThat(typeof envelope.payload === 'string' && envelope.payload.length <= 8192 && typeof envelope.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(envelope.signature),'invalid_grant',401);
  const issuer = ledger.issuer(envelope.kid); requireThat(issuer && !issuer.revoked && issuer.expiresAt > ledger.now(),'issuer_unavailable',401);
  const key = createPublicKey(issuer.publicKeyPem); requireThat(key.asymmetricKeyType === 'ed25519','invalid_issuer_key',401);
  requireThat(verify(null,Buffer.from(envelope.payload),key,Buffer.from(envelope.signature,'base64url')),'invalid_signature',401);
  let parsed:unknown; try { parsed=JSON.parse(envelope.payload); } catch { requireThat(false,'invalid_grant',401); }
  object(parsed); exact(parsed,['schema','aud','grantVersion','companyId','memberId','hostInstallationId','deviceId','licenseId','jobId','attemptId','revision','authorityVersion','operation','model','account','resource','jti','iat','exp','rateVersion','maxSpendNanoAud','requestDigest',...(parsed.schema===2?['modelCallId','maxAttemptSpendNanoAud','attemptExpiresAt','provider','allowedModels']:[])]);
  requireThat(envelope.payload === canonical(parsed),'noncanonical_grant',401);
  requireThat([1,2].includes(Number(parsed.schema)) && parsed.aud==='realbud-managed-ai' && parsed.grantVersion===parsed.schema && parsed.operation==='model.stream','invalid_grant_scope',403);
  ['companyId','memberId','hostInstallationId','deviceId','licenseId','jobId','attemptId','revision','authorityVersion','model','account','resource','jti','rateVersion'].forEach(k=>id(parsed[k]));
  integer(parsed.iat,Number.MAX_SAFE_INTEGER); integer(parsed.exp,Number.MAX_SAFE_INTEGER); nano(parsed.maxSpendNanoAud);
  if (parsed.schema===2) {
    id(parsed.modelCallId); id(parsed.provider); nano(parsed.maxAttemptSpendNanoAud); integer(parsed.attemptExpiresAt,Number.MAX_SAFE_INTEGER);
    requireThat(parsed.exp<=parsed.attemptExpiresAt,'parent_deadline_exceeded',403);
    requireThat(Array.isArray(parsed.allowedModels) && parsed.allowedModels.length>0 && parsed.allowedModels.length<=8,'invalid_model_scope',403);
    for(const entry of parsed.allowedModels) {
      object(entry); exact(entry,['provider','model','capabilities']); id(entry.provider); id(entry.model);
      requireThat(Array.isArray(entry.capabilities) && entry.capabilities.length>0 && entry.capabilities.length<=2 && entry.capabilities.every(c=>['text','tools'].includes(c)) && new Set(entry.capabilities).size===entry.capabilities.length,'invalid_capability_scope',403);
    }
    requireThat(parsed.allowedModels.some(e=>e.provider===parsed.provider && e.model===parsed.model && e.capabilities.includes('text') && (!(request.tools?.length) || e.capabilities.includes('tools'))),'model_scope_denied',403);
  }
  const now = ledger.now(); requireThat(parsed.iat<=now && parsed.exp>now && parsed.exp-parsed.iat<=300_000,'grant_expired',401);
  requireThat(parsed.companyId === issuer.companyId && parsed.hostInstallationId === issuer.hostInstallationId,'issuer_scope_mismatch',403);
  requireThat(parsed.model===request.model && parsed.rateVersion===request.rateVersion && parsed.requestDigest===digest(request),'request_scope_mismatch',403);
  const grant=parsed as unknown as ExecutionGrant; ledger.assertService(grant); return grant;
}
