import type { AgencyWorkflowPackId } from './agency-workflow-packs.ts';
import type { MailHistoryStatus } from './mail-ingestion.ts';

export const AGENCY_WORKFLOWS = ['bank-references', 'bills-calendar', 'morning-priorities'] as const;
export type AgencyWorkflowId = typeof AGENCY_WORKFLOWS[number];
export const AGENCY_WORKFLOW_NAMES: Record<AgencyWorkflowId, string> = {
  'bank-references': 'Bank references and reconciliation handoff',
  'bills-calendar': 'Bills and calendar',
  'morning-priorities': 'Morning priorities and unanswered follow-ups',
};
export interface AgencyReference { propertyId: string; reference: string; aliases: string[] }
export interface AgencySetupSettings {
  agencyName: string;
  workflowPackId: AgencyWorkflowPackId | null;
  timeZone: string;
  gmailAccountId: string | null;
  mailScope: { historyDays: number; includeSent: boolean; maxMessages: number; attachments: 'metadata-only' };
  propertyReferences: AgencyReference[];
  selectedWorkflows: AgencyWorkflowId[];
  morningReview: { localTime: string; weekdays: number[]; followUpAfterDays: number };
}
export interface AgencySetupReview {
  settingsRevision: number; evidenceDigest: string; reviewedAt: number; actorId: string;
}
export interface AgencySetupState {
  version: 1; workspaceId: string; revision: number; updatedAt: number | null;
  settings: AgencySetupSettings;
  reviews: Partial<Record<AgencyWorkflowId, AgencySetupReview>>;
}
/** Observations come only from host-owned stores/adapters. A settings form must
 * never provide any of these verification fields. GET must not call providers. */
export interface AgencySetupObservations {
  gmail?: {
    accounts: { id: string; label: string; status: 'active' | 'unavailable' }[];
    accountId: string | null;
    state: 'verified' | 'unverified' | 'revoked' | 'error';
    checkedAt: number | null;
    /** Stable source/authority configuration revision, not a credential. */
    bindingRevision: string | null;
  };
  /** Progress of the automatic history acquisition for the selected account.
   * Evidence only: it never makes a check pass and never claims completeness. */
  mailHistory?: MailHistoryStatus;
  properties?: { state: 'available' | 'unavailable'; revision: string; items: { id: string; label: string }[] };
  billRegister?: { state: 'available' | 'unavailable'; count: number };
  workflows?: Partial<Record<AgencyWorkflowId, {
    /** The actual adapter and its required plan/worker checks, not installed=true. */
    state: 'available' | 'needs-review' | 'unavailable';
    bindingRevision: string;
    detail: string;
    sourceReceipt?: { id: string; capturedAt: number; state: 'complete' | 'partial' | 'held'; accountId?: string };
    acceptanceReceipt?: { id: string; acceptedAt: number; settingsRevision: number; evidenceDigest: string };
  }>>;
}
export interface AgencySetupCheck {
  id: string; label: string; state: 'passed' | 'needed' | 'unknown'; detail: string; nextAction: string;
  requiredForReview: boolean;
}
export interface AgencyWorkflowSetupStatus {
  id: AgencyWorkflowId; title: string; selected: boolean; checks: AgencySetupCheck[];
  evidenceDigest: string; canReview: boolean; reviewed: boolean; readyForRun: boolean;
  acceptance: 'not-verified' | 'accepted';
}
export interface AgencySetupView {
  state: AgencySetupState;
  accounts: NonNullable<AgencySetupObservations['gmail']>['accounts'];
  properties: NonNullable<AgencySetupObservations['properties']>['items'];
  workflows: AgencyWorkflowSetupStatus[];
  canCheckGmail: boolean;
}
