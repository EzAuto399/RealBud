/** Company authority for one assigned case. This is not website approval,
 * provider access, or a general company member session. Secrets are host-only. */
export const COMPANY_EXECUTION_PURPOSE = 'local-department-prepare-v1' as const;
export const COMPANY_EXECUTION_GRANT_MS = 7 * 86_400_000;
export const COMPANY_EXECUTION_LEASE_MS = 300_000;
export const COMPANY_EXECUTION_DISPATCH_MS = 60_000;
/** Complete, bounded material the owner reviews. Legacy metadata-only grants
 * remain readable, but cannot enter the application worker integration. */
export type CompanyExecutionReview = {
  plan: { title: string; description: string; steps: string[]; evidence: string;
    capabilities: ('analyse' | 'draft')[]; allowedOrigins: string[];
    limits: { maxRuntimeMinutes: number; maxTurns: number }; siteNotes: string | null };
  instructions: string;
};
export type CompanyExecutionRecipe = { id: string; revision: number; digest: string; instructionDigest: string; review?: CompanyExecutionReview };
export type CompanyExecutionExecutor = { workspaceId: string; workerBinding: string };
export type CompanyExecutionSource = { caseId: string; title: string; description: string };
export type CompanyExecutionSpec = {
  version: 1; purpose: typeof COMPANY_EXECUTION_PURPOSE;
  companyId: string; memberId: string; authorityId: string; certificateDigest: string;
  departmentId: string; departmentRevision: string; caseId: string; caseFence: string;
  sourceDigest: string; recipe: CompanyExecutionRecipe; executor: CompanyExecutionExecutor;
};
export type BeginCompanyExecution = {
  version: 1; requestId: string; grantSecret: string;
  departmentId: string; expectedDepartmentRevision: string; caseId: string; expectedCaseFence: string;
  recipe: CompanyExecutionRecipe; executor: CompanyExecutionExecutor; durationMs: number;
};
export type ConfirmCompanyExecution = { version: 1; requestId: string; grantId: string; expectedRevision: string; grantDigest: string };
export type RevokeCompanyExecution = { version: 1; requestId: string; grantId: string; expectedRevision: string; note: string };
export type CompanyExecutionGrant = {
  id: string; revision: string; phase: 'pending' | 'active' | 'admitted' | 'revoked'; current: boolean;
  spec: CompanyExecutionSpec; digest: string; departmentName: string; memberName: string; source: CompanyExecutionSource;
  createdAt: string; expiresAt: string; confirmedAt: string | null; revokedAt: string | null;
};
export type CompanyExecutionGrantPage = { grants: CompanyExecutionGrant[]; offset: number; hasMore: boolean; canManage: boolean };
export type AdmitCompanyExecution = { version: 1; grantId: string; requestId: string; executionId: string; claimSecret: string; ttlMs: number };
export type CheckCompanyExecution = { version: 1; grantId: string; executionId: string; claimSecret: string; fence: string };
export type RenewCompanyExecution = CheckCompanyExecution & { requestId: string; ttlMs: number };
export type SettleCompanyExecution = CheckCompanyExecution & { requestId: string; runId: string; outcome: 'prepared' | 'interrupted' | 'failed'; note: string };
export type CompanyExecutionReceipt = { version: 1; grantId: string; receiptId: string; executionId: string; caseId: string; fence: string; leaseExpiresAt: string; dispatchBefore: string };
export type CompanyExecutionCheck = { receipt: CompanyExecutionReceipt; source: CompanyExecutionSource };
export type CompanyExecutionSettlement = { receiptId: string; caseId: string; fence: string; status: 'recovery_required'; outcome: 'prepared' | 'interrupted' | 'failed'; runId: string };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export const companyExecutionUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const operationId = (v: unknown): v is string => companyExecutionUuid(v) && v[14] === '4' && /^[89ab]$/.test(v[19]);
export const companyExecutionSecret = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= BigInt('9223372036854775807');
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || !!v.trim()) && !v.includes('\0');
const duration = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= 100 && Number(v) <= max;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function recipe(v: unknown): v is CompanyExecutionRecipe {
  return object(v) && exact(v, ['id','revision','digest','instructionDigest', ...('review' in v ? ['review'] : [])]) && text(v.id, 128) && Number.isSafeInteger(v.revision) && Number(v.revision) >= 1 && companyExecutionSecret(v.digest) && companyExecutionSecret(v.instructionDigest) && (!('review' in v) || isCompanyExecutionReview(v.review));
}
export function isCompanyExecutionReview(v: unknown): v is CompanyExecutionReview {
  if (!object(v) || !exact(v,['plan','instructions']) || !object(v.plan) || !text(v.instructions,20_000,true)) return false;
  const p=v.plan;
  return exact(p,['title','description','steps','evidence','capabilities','allowedOrigins','limits','siteNotes']) &&
    text(p.title,240) && text(p.description,12_000,true) && text(p.evidence,4000,true) &&
    Array.isArray(p.steps) && p.steps.length>0 && p.steps.length<=30 && p.steps.every(s=>text(s,4000)) &&
    Array.isArray(p.capabilities) && p.capabilities.length>0 && p.capabilities.length<=2 && new Set(p.capabilities).size===p.capabilities.length && p.capabilities.every(c=>c==='analyse'||c==='draft') &&
    Array.isArray(p.allowedOrigins) && p.allowedOrigins.length===0 &&
    object(p.limits) && exact(p.limits,['maxRuntimeMinutes','maxTurns']) && Number.isInteger(p.limits.maxRuntimeMinutes) && Number(p.limits.maxRuntimeMinutes)>=1 && Number(p.limits.maxRuntimeMinutes)<=5 &&
    Number.isInteger(p.limits.maxTurns) && Number(p.limits.maxTurns)>=1 && Number(p.limits.maxTurns)<=12 &&
    (p.siteNotes===null||text(p.siteNotes,8000,true)) && new TextEncoder().encode(JSON.stringify(v)).length<=20_000;
}
function executor(v: unknown): v is CompanyExecutionExecutor {
  return object(v) && exact(v, ['workspaceId','workerBinding']) && text(v.workspaceId,128) && text(v.workerBinding,256);
}
export function isCompanyExecutionSource(v: unknown): v is CompanyExecutionSource {
  return object(v) && exact(v,['caseId','title','description']) && companyExecutionUuid(v.caseId) && text(v.title,240) && text(v.description,4000,true);
}
export function isCompanyExecutionSpec(v: unknown): v is CompanyExecutionSpec {
  return object(v) && exact(v,['version','purpose','companyId','memberId','authorityId','certificateDigest','departmentId','departmentRevision','caseId','caseFence','sourceDigest','recipe','executor']) &&
    v.version === 1 && v.purpose === COMPANY_EXECUTION_PURPOSE && [v.companyId,v.memberId,v.authorityId,v.departmentId,v.caseId].every(companyExecutionUuid) &&
    decimal(v.departmentRevision) && decimal(v.caseFence) && companyExecutionSecret(v.certificateDigest) && companyExecutionSecret(v.sourceDigest) && recipe(v.recipe) && executor(v.executor);
}
export function isBeginCompanyExecution(v: unknown): v is BeginCompanyExecution {
  return object(v) && exact(v,['version','requestId','grantSecret','departmentId','expectedDepartmentRevision','caseId','expectedCaseFence','recipe','executor','durationMs']) && v.version === 1 && operationId(v.requestId) && companyExecutionSecret(v.grantSecret) && companyExecutionUuid(v.departmentId) && decimal(v.expectedDepartmentRevision) && companyExecutionUuid(v.caseId) && decimal(v.expectedCaseFence) && recipe(v.recipe) && executor(v.executor) && duration(v.durationMs,COMPANY_EXECUTION_GRANT_MS);
}
export function isConfirmCompanyExecution(v: unknown): v is ConfirmCompanyExecution {
  return object(v) && exact(v,['version','requestId','grantId','expectedRevision','grantDigest']) && v.version === 1 && operationId(v.requestId) && operationId(v.grantId) && decimal(v.expectedRevision) && companyExecutionSecret(v.grantDigest);
}
export function isRevokeCompanyExecution(v: unknown): v is RevokeCompanyExecution {
  return object(v) && exact(v,['version','requestId','grantId','expectedRevision','note']) && v.version === 1 && operationId(v.requestId) && operationId(v.grantId) && decimal(v.expectedRevision) && text(v.note,2048);
}
export function isAdmitCompanyExecution(v: unknown): v is AdmitCompanyExecution {
  return object(v) && exact(v,['version','grantId','requestId','executionId','claimSecret','ttlMs']) && v.version === 1 && operationId(v.grantId) && operationId(v.requestId) && operationId(v.executionId) && companyExecutionSecret(v.claimSecret) && duration(v.ttlMs,COMPANY_EXECUTION_LEASE_MS);
}
const checkFields = ['version','grantId','executionId','claimSecret','fence'];
function check(v: Record<string,unknown>): boolean { return v.version === 1 && operationId(v.grantId) && operationId(v.executionId) && companyExecutionSecret(v.claimSecret) && decimal(v.fence); }
export function isCheckCompanyExecution(v: unknown): v is CheckCompanyExecution { return object(v) && exact(v,checkFields) && check(v); }
export function isRenewCompanyExecution(v: unknown): v is RenewCompanyExecution { return object(v) && exact(v,[...checkFields,'requestId','ttlMs']) && check(v) && operationId(v.requestId) && duration(v.ttlMs,COMPANY_EXECUTION_LEASE_MS); }
export function isSettleCompanyExecution(v: unknown): v is SettleCompanyExecution { return object(v) && exact(v,[...checkFields,'requestId','runId','outcome','note']) && check(v) && operationId(v.requestId) && text(v.runId,128) && typeof v.outcome === 'string' && ['prepared','interrupted','failed'].includes(v.outcome) && text(v.note,2048,true); }
export function isCompanyExecutionReceipt(v: unknown): v is CompanyExecutionReceipt {
  return object(v) && exact(v,['version','grantId','receiptId','executionId','caseId','fence','leaseExpiresAt','dispatchBefore']) && v.version === 1 && [v.grantId,v.receiptId,v.executionId].every(operationId) && companyExecutionUuid(v.caseId) && decimal(v.fence) && instant(v.leaseExpiresAt) && instant(v.dispatchBefore) && Date.parse(v.dispatchBefore) <= Date.parse(v.leaseExpiresAt);
}
export function isCompanyExecutionCheck(v: unknown): v is CompanyExecutionCheck { return object(v) && exact(v,['receipt','source']) && isCompanyExecutionReceipt(v.receipt) && isCompanyExecutionSource(v.source) && v.receipt.caseId === v.source.caseId; }
export function isCompanyExecutionSettlement(v: unknown): v is CompanyExecutionSettlement { return object(v) && exact(v,['receiptId','caseId','fence','status','outcome','runId']) && operationId(v.receiptId) && companyExecutionUuid(v.caseId) && decimal(v.fence) && v.status === 'recovery_required' && typeof v.outcome === 'string' && ['prepared','interrupted','failed'].includes(v.outcome) && text(v.runId,128); }
export function isCompanyExecutionGrant(v: unknown): v is CompanyExecutionGrant {
  return object(v) && exact(v,['id','revision','phase','current','spec','digest','departmentName','memberName','source','createdAt','expiresAt','confirmedAt','revokedAt']) && operationId(v.id) && decimal(v.revision) && typeof v.phase === 'string' && ['pending','active','admitted','revoked'].includes(v.phase) && typeof v.current === 'boolean' && isCompanyExecutionSpec(v.spec) && companyExecutionSecret(v.digest) && text(v.departmentName,120) && text(v.memberName,120) && isCompanyExecutionSource(v.source) && v.source.caseId === v.spec.caseId && instant(v.createdAt) && instant(v.expiresAt) && (v.confirmedAt === null || instant(v.confirmedAt)) && (v.revokedAt === null || instant(v.revokedAt)) && Date.parse(v.expiresAt) > Date.parse(v.createdAt) && Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= COMPANY_EXECUTION_GRANT_MS && (v.confirmedAt === null || Date.parse(v.confirmedAt) >= Date.parse(v.createdAt) && Date.parse(v.confirmedAt) < Date.parse(v.expiresAt)) && (v.revokedAt === null || Date.parse(v.revokedAt) >= Date.parse(v.createdAt)) && (v.phase === 'revoked' ? v.revokedAt !== null && !v.current : v.revokedAt === null) && (v.phase === 'pending' ? v.confirmedAt === null : v.phase === 'revoked' || v.confirmedAt !== null);
}
export function isCompanyExecutionGrantPage(v: unknown): v is CompanyExecutionGrantPage { return object(v) && exact(v,['grants','offset','hasMore','canManage']) && Array.isArray(v.grants) && v.grants.length <= 100 && v.grants.every(isCompanyExecutionGrant) && Number.isSafeInteger(v.offset) && Number(v.offset) >= 0 && Number(v.offset) <= 1000 && typeof v.hasMore === 'boolean' && typeof v.canManage === 'boolean'; }
