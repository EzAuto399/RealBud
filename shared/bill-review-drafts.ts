import type { SourceBillState, BillFinancialObservation, BillMaintenanceClassification } from './source-bills.ts';

/** Untrusted editor recovery only. A draft never approves a source or a bill. */
export type BillReviewDraftState = 'editing' | 'saved' | 'accepted' | 'discarded';
export interface BillReviewDraftFields {
  propertyId: string; kind: string; vendor: string; amount: string;
  invoiceDate: string; dueDate: string; note: string;
  invoiceNumber?: string; invoiceVersion?: string;
  supplierReference?: string; workDescription?: string; maintenanceClassification?: BillMaintenanceClassification;
}
export interface BillReviewDraftProposalRequest {
  requestId: string; itemId: string; messageId: string; expectedSourceDigest: string;
}
/** Raw editor recovery; source review confirmation is deliberately not saved. */
export interface BillFinancialReviewDraft extends Omit<BillFinancialObservation, 'sourceIds' | 'observedAt'> {
  sourceIds: string; observedAt: string; reviewReason: string;
}
export interface BillOriginalSourceReference { itemId: string; messageId: string; expectedSourceDigest: string; expectedEnvelopeDigest: string }
export interface BillReviewDraftValue {
  workspaceId: string;
  state: BillReviewDraftState;
  billId: string | null; billRevision: number | null;
  itemId: string | null; messageId: string | null; sourceDigest: string | null;
  fields: BillReviewDraftFields;
  billState: SourceBillState;
  reason: string;
  seriesId: string;
  arrivalDate: string;
  /** Once saved, this exact tuple and its selected source cannot be changed. */
  proposalRequest: BillReviewDraftProposalRequest | null;
  financialReview?: BillFinancialReviewDraft;
  /** Recovery reference only; explicit original-source review is never saved. */
  forwardedOriginalSource?: BillOriginalSourceReference | null;
}
export interface BillReviewDraft extends BillReviewDraftValue {
  version: 1; id: string; revision: number; createdAt: number; updatedAt: number;
}
export interface BillReviewDraftSummary {
  id: string; revision: number; state: BillReviewDraftState;
  createdAt: number; updatedAt: number;
  billId: string | null; itemId: string | null; messageId: string | null;
  propertyId: string; kind: string; vendor: string; hasProposalRequest: boolean;
  hasFinancialReview?: boolean;
}
export type BillReviewDraftFilter = 'active' | 'all';
export interface BillReviewDraftPageQuery { filter?: BillReviewDraftFilter; limit?: number; cursor?: string }
/** Insertion snapshot excludes new drafts. Existing edits and closures remain
 * current; total is the matching population in that snapshot at this read. */
export interface BillReviewDraftPage {
  version: 1; workspaceId: string; filter: BillReviewDraftFilter;
  items: BillReviewDraftSummary[]; total: number; nextCursor: string | null;
}
export const BILL_REVIEW_DRAFT_LIMITS = {
  propertyId: 200, kind: 80, vendor: 160, amount: 80,
  invoiceDate: 32, dueDate: 32, note: 8000,
  invoiceNumber: 120, invoiceVersion: 80, supplierReference: 120, workDescription: 1000, maintenanceClassification: 20,
  reason: 4000, seriesId: 180, arrivalDate: 32,
} as const;
/** Both UTF-8 plaintext and its encrypted stored envelope obey this ceiling. */
export const BILL_REVIEW_DRAFT_MAX_BYTES = 64 * 1024;
