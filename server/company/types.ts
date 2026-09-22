export type ScopeKind = 'private' | 'team' | 'company';
export type ScopePermission = 'read' | 'write';
export interface CompanyActor {
  companyId: string;
  memberId: string;
  displayName: string;
  role: 'owner' | 'member';
  sessionId: string;
}
export interface CompanyScope {
  id: string;
  companyId: string;
  ownerMemberId: string;
  kind: ScopeKind;
  name: string;
  revision: string;
}
export interface KnowledgeRevision {
  scopeId: string;
  key: string;
  revision: string;
  content: string;
  sourceRefs: string[];
  authorMemberId: string;
  createdAt: string;
}
export interface CaseClaim {
  caseId: string;
  fence: string;
  claimToken: string;
  expiresAt: string;
}
export type CompanyErrorCode = 'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'claim_busy' | 'stale_claim' | 'recovery_required' | 'owner_proof_required' | 'owner_transfer_required' | 'work_resolution_required' | 'unsafe_database_role';
export class CompanyError extends Error {
  readonly code: CompanyErrorCode;
  constructor(code: CompanyErrorCode, message: string = code) {
    super(message);
    this.code = code;
    this.name = 'CompanyError';
  }
}
