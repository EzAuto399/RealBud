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
  invitationToken: string;
  expiresAt: string;
}
