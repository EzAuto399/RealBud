/** Public company setup responses. Never include database or service credentials. */
import type { Recipe } from './contracts.ts';

export type CompanyWorkflowTemplate = { version: 1; recipes: Array<Pick<Recipe,
  'id' | 'title' | 'description' | 'steps' | 'evidence' | 'capabilities' | 'allowedOrigins' | 'limits' | 'schedule'>> };
export interface CompanyWorkflowTemplateState {
  revision: string;
  template: CompanyWorkflowTemplate | null;
  updatedAt: string | null;
}

export interface CompanySummary {
  id: string;
  name: string;
}

export interface CompanyMemberSummary {
  id: string;
  displayName: string;
  role: "owner" | "member";
}

export interface CompanyStatus {
  storageAvailable: boolean;
  configured: boolean;
  setupAllowed: boolean;
  ownerRecoveryAllowed?: boolean;
  transport: "local-only" | "encrypted-company";
  storageSetupAvailable?: boolean;
  remoteJoinAvailable?: boolean;
  hostingAvailable?: boolean;
  networkEnabled?: boolean;
  setupError?: string;
  networkError?: string;
  hostMode?: 'active' | 'standby' | 'retired';
  hostRecoveryAvailable?: boolean;
  enrollmentPending?: boolean;
  remoteHost?: boolean;
  departurePending?: 'leave' | 'disconnect';
  company?: CompanySummary;
  member?: CompanyMemberSummary;
  limitations: string[];
}

export interface CompanySessionResponse {
  memberToken: string;
  recoveryKey?: string;
  company: CompanySummary;
  member: CompanyMemberSummary;
}

export interface CompanyInvitationResponse {
  invitationId?: string;
  invitationToken: string;
  expiresAt: string;
}

export interface CompanyManagement {
  offset: number;
  hasMore: boolean;
  unresolvedWork: boolean;
  members: Array<CompanyMemberSummary & { active: boolean; joinedAt: string | null }>;
  invitations: Array<{ id: string; displayName: string; expiresAt: string | null; redeemedAt: string | null; revokedAt: string | null }>;
  transfer: { id: string; fromMemberId: string; toMemberId: string; expiresAt: string | null } | null;
}

export type DepartmentAccess = 'none' | 'read' | 'write';
export interface CompanyDepartment {
  id: string; name: string; revision: string; access: DepartmentAccess;
  retiredAt: string | null; retiredBy: string | null; retirementNote: string;
  unresolvedCases: number;
}
export interface DepartmentPage { departments: CompanyDepartment[]; canManage: boolean; offset: number; hasMore: boolean }
export interface DepartmentAccessPage {
  department: CompanyDepartment;
  members: Array<CompanyMemberSummary & { access: DepartmentAccess }>;
  offset: number;
  hasMore: boolean;
}

export interface DepartmentCase {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'claimed' | 'recovery_required' | 'done' | 'cancelled';
  fence: string;
  assignee: { id: string; displayName: string; active: boolean; canWrite: boolean } | null;
  needsAssignment: boolean;
  canAssign: boolean;
  canClose: boolean;
  holder: { id: string; displayName: string; active: boolean } | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  needsReview: boolean;
  lastRecovery: { receiptId: string; resolution: 'done' | 'released'; note: string; reviewedBy: string; reviewedAt: string } | null;
  lastClosure: { receiptId: string; resolution: 'done' | 'cancelled'; note: string; recordedBy: string; recordedAt: string } | null;
}
export interface DepartmentCasePage {
  department: CompanyDepartment;
  cases: DepartmentCase[];
  canRecover: boolean;
  canCreate: boolean;
  filter: 'needs-review' | 'all';
  offset: number;
  hasMore: boolean;
}
export interface RecoverDepartmentCaseInput {
  departmentId: string;
  caseId: string;
  requestId: string;
  expectedFence: string;
  resolution: 'done' | 'released';
  note: string;
}

export interface CreateDepartmentCaseInput {
  departmentId: string; requestId: string; title: string; description: string;
  assigneeMemberId: string | null;
}
export interface AssignDepartmentCaseInput {
  departmentId: string; caseId: string; requestId: string; expectedFence: string;
  assigneeMemberId: string | null;
}
export interface CloseDepartmentCaseInput {
  departmentId: string; caseId: string; requestId: string; expectedFence: string;
  resolution: 'done' | 'cancelled'; note: string;
}
export interface DepartmentCaseMutation { item: DepartmentCase; receiptId: string; replayed: boolean }
export interface DepartmentAssigneePage {
  department: CompanyDepartment; members: CompanyMemberSummary[]; offset: number; hasMore: boolean;
}
export interface DepartmentLifecycleInput {
  departmentId: string; requestId: string; expectedRevision: string; retired: boolean; note: string;
}
export interface DepartmentLifecycleResult { department: CompanyDepartment; receiptId: string; replayed: boolean }
