/** Reviewed collaboration content only. No conversations, credentials or execution grants. */
export type SharedWorkPurpose = 'share-result' | 'request-review' | 'handoff';
export type SharedWorkState = 'open' | 'accepted' | 'responded' | 'closed';
/** A deliberately selected, portable text copy. References never grant source access. */
export interface SharedWorkEvidence { label: string; sourceRef: string; sourceVersion: string; text: string }
export interface SharedWorkActivity {
  revision: string;
  action: 'shared' | 'accepted' | 'reassigned' | 'responded' | 'closed';
  actor: SharedWorkPerson;
  at: string;
  assignee: SharedWorkPerson | null;
  response: string;
}
export interface SharedWorkPerson { id: string; displayName: string }
export interface SharedWorkItem {
  id: string;
  scopeId: string;
  revision: string;
  title: string;
  summary: string;
  purpose: SharedWorkPurpose;
  state: SharedWorkState;
  owner: SharedWorkPerson;
  assignee: SharedWorkPerson | null;
  audience: SharedWorkPerson[];
  response: string;
  updatedBy: SharedWorkPerson;
  updatedAt: string;
  evidence?: (SharedWorkEvidence & { sha256: string }) | null;
  acceptedBy?: SharedWorkPerson | null;
  ownerAvailable?: boolean;
  /** Current viewer permissions; the service rechecks them on every mutation. */
  actions: { respond: boolean; close: boolean; accept?: boolean; reassign?: boolean; addRecipient?: boolean };
}
export interface ShareWorkInput {
  requestId: string;
  title: string;
  summary: string;
  purpose: SharedWorkPurpose;
  recipientMemberIds: string[];
  assigneeMemberId: string | null;
  evidence?: SharedWorkEvidence | null;
}
export interface RespondToSharedWorkInput { id: string; expectedRevision: string; response: string }
export interface CloseSharedWorkInput { id: string; expectedRevision: string }
export interface AcceptSharedWorkInput { id: string; expectedRevision: string }
export interface ReassignSharedWorkInput { id: string; expectedRevision: string; assigneeMemberId: string }
